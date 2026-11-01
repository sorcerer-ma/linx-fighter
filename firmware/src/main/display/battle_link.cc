// 战斗 HUD 推送接收（HudLink）
// 与拉取版（battle_pull）共用同一份 HUD 解析：帧号去重、battle_hud 渲染、cue 播音效。
// 设备端只维护一条长连接，断线后退避重连；网络没就绪时先等着，避免在 lwIP 起来前发包。
#include "battle_link.h"

#include "application.h"
#include "battle_hud.h"
#include "battle_pull.h"
#include "board.h"
#include "settings.h"

#include <esp_log.h>
#include <esp_mac.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <cstdio>
#include <memory>
#include <cstring>
#include <string>

namespace {
constexpr char TAG[] = "BattleLink";

// 与拉取通道共用 NVS 命名空间，另存一套键，互不覆盖
constexpr char kNamespace[] = "hud";
constexpr char kKeyUrl[] = "ws_url";
constexpr char kKeyEnabled[] = "ws_on";

constexpr int kTickMs = 200;        // 主循环节拍：检查连接状态与保活
constexpr int kRetryMs = 3000;      // 断线重连间隔
constexpr int kPingMs = 20000;      // 保活间隔，低于服务端 25s 心跳
constexpr int kWaitNetworkMs = 800; // 网络没就绪时的等待

struct LinkConfig {
    std::string url;
    bool enabled = false;
};

// 设备身份用 WiFi STA MAC，与服务端 deviceId 口径一致
std::string DeviceMac() {
    uint8_t mac[6] = {};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
        return {};
    }
    char buffer[18];
    std::snprintf(buffer, sizeof(buffer), "%02x:%02x:%02x:%02x:%02x:%02x",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return buffer;
}

// 地址没带 device 参数时补上，服务端据此找这台设备的对局
std::string WithDevice(const std::string &url) {
    if (url.find("device=") != std::string::npos) {
        return url;
    }
    const std::string mac = DeviceMac();
    if (mac.empty()) {
        return url;
    }
    return url + (url.find('?') == std::string::npos ? "?" : "&") + "device=" + mac;
}

LinkConfig LoadConfig() {
    Settings settings(kNamespace, false);
    LinkConfig config;
    config.url = settings.GetString(kKeyUrl, "");
    config.enabled = settings.GetBool(kKeyEnabled, false);
    return config;
}

bool SaveConfig(const std::string &url, bool enabled) {
    Settings settings(kNamespace, true);
    settings.SetString(kKeyUrl, url);
    settings.SetBool(kKeyEnabled, enabled);
    return true;
}

// 设备状态机没到「可联网」之前不建连：与拉取通道同一道闸
bool NetworkReady() {
    auto state = Application::GetInstance().GetDeviceState();
    switch (state) {
        case kDeviceStateStarting:
        case kDeviceStateWifiConfiguring:
        case kDeviceStateActivating:
        case kDeviceStateUpgrading:
            return false;
        default:
            return true;
    }
}

struct LinkRuntime {
    std::unique_ptr<WebSocket> socket;
    bool connected = false;
    int64_t last_connect_ms = 0;
    int64_t last_ping_ms = 0;
    int64_t last_warn_ms = 0;
};

void WarnThrottled(LinkRuntime &runtime, const char *message) {
    int64_t now = esp_log_timestamp();
    if (now - runtime.last_warn_ms < 30000) {
        return;
    }
    runtime.last_warn_ms = now;
    ESP_LOGW(TAG, "%s", message);
}

void ConnectOnce(LinkRuntime &runtime, const LinkConfig &config) {
    auto network = Board::GetInstance().GetNetwork();
    if (network == nullptr) {
        WarnThrottled(runtime, "network unavailable");
        return;
    }
    auto socket = network->CreateWebSocket(1);
    if (socket == nullptr) {
        WarnThrottled(runtime, "create websocket failed");
        return;
    }
    const std::string mac = DeviceMac();
    socket->SetHeader("X-Linx-Device-Id", mac.c_str());
    socket->SetReceiveBufferSize(4096);

    socket->OnData([&runtime](const char *data, size_t len, bool binary) {
        if (binary || data == nullptr || len == 0) {
            return;
        }
        // 服务端推的就是一帧 HUD JSON，解析与拉取通道完全一致
        battle_pull_apply_json(data, len);
    });
    socket->OnDisconnected([&runtime]() {
        runtime.connected = false;
        ESP_LOGW(TAG, "link disconnected");
    });
    socket->OnError([&runtime](int error) {
        runtime.connected = false;
        ESP_LOGW(TAG, "link error: %d", error);
    });

    const std::string url = WithDevice(config.url);
    ESP_LOGI(TAG, "link url -> %s", url.c_str());
    if (socket->Connect(url.c_str())) {
        runtime.connected = true;
        runtime.last_ping_ms = esp_log_timestamp();
        ESP_LOGI(TAG, "link connected");
    } else {
        runtime.last_connect_ms = esp_log_timestamp();
        WarnThrottled(runtime, "link connect failed");
    }
    runtime.socket = std::move(socket);
}

void LinkTask(void *) {
    LinkRuntime runtime;
    for (;;) {
        const LinkConfig config = LoadConfig();
        const int64_t now = esp_log_timestamp();

        if (!config.enabled || config.url.empty()) {
            if (runtime.socket) {
                runtime.socket->Close();
                runtime.socket.reset();
                runtime.connected = false;
            }
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }
        if (!NetworkReady()) {
            vTaskDelay(pdMS_TO_TICKS(kWaitNetworkMs));
            continue;
        }
        if (!runtime.connected) {
            if (runtime.socket == nullptr || now - runtime.last_connect_ms >= kRetryMs) {
                runtime.last_connect_ms = now;
                ConnectOnce(runtime, config);
            }
        } else if (now - runtime.last_ping_ms >= kPingMs) {
            runtime.last_ping_ms = now;
            if (runtime.socket) {
                runtime.socket->Ping();
            }
        }
        vTaskDelay(pdMS_TO_TICKS(kTickMs));
    }
}
}  // namespace

bool battle_link_configure(const char *url, bool enabled, char *out, size_t out_len) {
    if (url == nullptr || url[0] == '\0') {
        return false;
    }
    if (std::strncmp(url, "ws://", 5) != 0 && std::strncmp(url, "wss://", 6) != 0) {
        return false;
    }
    const std::string final_url = WithDevice(url);
    if (!SaveConfig(final_url, enabled)) {
        return false;
    }
    if (out != nullptr && out_len > 0) {
        std::snprintf(out, out_len, "%s", final_url.c_str());
    }
    // 两条通道同时开只会重复下发，启用推送时顺手关掉拉取
    if (enabled) {
        battle_pull_configure(nullptr, false, nullptr, 0);
    }
    ESP_LOGI(TAG, "link configured: %s (enabled=%d)", final_url.c_str(), enabled);
    return true;
}

bool battle_link_enabled(void) {
    return LoadConfig().enabled;
}

void battle_link_start(void) {
    BaseType_t ok = xTaskCreate(LinkTask, "battle_link", 8192, nullptr, 3, nullptr);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "failed to create link task");
        return;
    }
    ESP_LOGI(TAG, "link task started, heap=%u", static_cast<unsigned>(esp_get_free_heap_size()));
}
