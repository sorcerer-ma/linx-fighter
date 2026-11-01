// 战斗 HUD 拉取（HudClient）
// 服务端在 /device/mcp 暴露只读工具 game_hud，返回一帧可直接渲染的画面状态；
// 本模块按 seq 去重后交给 battle_hud 渲染，并负责把 cue 转成提示音。
#include "battle_pull.h"

#include "application.h"

#include "battle_hud.h"
#include "board.h"
#include "mcp_server.h"
#include "settings.h"

#include <cJSON.h>
#include <esp_log.h>
#include <esp_system.h>
#include <esp_mac.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <cstdio>
#include <cstring>
#include <string>

namespace {
constexpr char TAG[] = "BattlePull";

// 配置存在 NVS 独立命名空间，避免写入语音/网络已有的键
constexpr char kNamespace[] = "hud";
constexpr char kKeyUrl[] = "url";
constexpr char kKeyEnabled[] = "enabled";

constexpr int kHttpTimeoutMs = 6000;   // 单次请求上限
constexpr int kLongPollMs = 1500;      // 服务端长轮询等待，避免空转
constexpr int kPollIntervalMs = 1200;  // 两次拉取间隔
constexpr int kFailBackoffMs = 3000;   // 失败退避，避免打满网络

int g_last_seq = -1;          // 已应用帧号，用于去重
int g_request_id = 0;         // JSON-RPC 请求号
int64_t g_last_warn_tick = 0; // 日志限频

struct PullConfig {
    std::string url;
    bool enabled = false;
};

PullConfig LoadConfig() {
    Settings settings(kNamespace, false);
    PullConfig config;
    config.url = settings.GetString(kKeyUrl, "");
    config.enabled = settings.GetBool(kKeyEnabled, false);
    return config;
}

// 设备身份用 WiFi STA MAC，与服务端 deviceId 口径一致
std::string DeviceIdHeader() {
    uint8_t mac[6] = {};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
        return {};
    }
    char buffer[18];
    std::snprintf(buffer, sizeof(buffer), "%02x:%02x:%02x:%02x:%02x:%02x",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return buffer;
}

void WarnThrottled(const char *message, int status) {
    int64_t now = esp_log_timestamp();
    if (now - g_last_warn_tick < 30000) {
        return;
    }
    g_last_warn_tick = now;
    ESP_LOGW(TAG, "%s (status=%d)", message, status);
}

// 从 JSON-RPC 响应体里取出 content[0].text（兼容 SSE 的 data: 行）
std::string ExtractHudText(const std::string &body) {
    const char *start = std::strchr(body.c_str(), '{');
    if (start == nullptr) {
        return {};
    }
    cJSON *root = cJSON_Parse(start);
    if (root == nullptr) {
        return {};
    }
    std::string text;
    const cJSON *result = cJSON_GetObjectItemCaseSensitive(root, "result");
    const cJSON *content = cJSON_GetObjectItemCaseSensitive(result, "content");
    const cJSON *first = cJSON_GetArrayItem(content, 0);
    const cJSON *text_item = cJSON_GetObjectItemCaseSensitive(first, "text");
    if (cJSON_IsString(text_item) && text_item->valuestring != nullptr) {
        text = text_item->valuestring;
    }
    cJSON_Delete(root);
    return text;
}

int IntField(const cJSON *root, const char *key, int fallback) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
    return cJSON_IsNumber(item) ? item->valueint : fallback;
}

bool BoolField(const cJSON *root, const char *key, bool fallback) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (cJSON_IsBool(item)) {
        return cJSON_IsTrue(item);
    }
    return fallback;
}

std::string StringField(const cJSON *root, const char *key) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
    return (cJSON_IsString(item) && item->valuestring != nullptr) ? item->valuestring : "";
}

// 解析一帧 HUD 状态；帧号未变化则直接忽略
bool ApplyHudJson(const std::string &json) {
    cJSON *root = cJSON_Parse(json.c_str());
    if (root == nullptr) {
        ESP_LOGW(TAG, "bad hud json: %s", json.c_str());
        return false;
    }

    const int seq = IntField(root, "seq", -1);
    if (seq >= 0 && seq == g_last_seq) {
        cJSON_Delete(root);
        return false;
    }

    // 字符串字段必须在 apply 调用期间保持有效
    std::string expression = StringField(root, "expression");
    std::string cue = StringField(root, "cue");
    if (expression.empty()) {
        expression = "neutral";
    }

    battle_hud_state_t state = {};
    state.expression = expression.c_str();
    state.hp = IntField(root, "hp", 0);
    state.max_hp = IntField(root, "max_hp", 1);
    state.energy = IntField(root, "energy", 0);
    state.max_energy = IntField(root, "max_energy", 5);
    state.ult = IntField(root, "ult", 0);
    state.seq = seq;
    state.cue = cue.empty() ? nullptr : cue.c_str();
    state.hold_ms = IntField(root, "hold_ms", 0);
    state.battle = BoolField(root, "battle", true);
    std::string mode = StringField(root, "mode");
    state.mode = mode.empty() ? nullptr : mode.c_str();

    // 对手资源：服务端在同一帧里给出对面玩家的血/能量/大招，缺省时不画上排
    cJSON *opponent = cJSON_GetObjectItem(root, "opponent");
    if (cJSON_IsObject(opponent)) {
        state.has_opponent = true;
        state.opp_hp = IntField(opponent, "hp", 0);
        state.opp_max_hp = IntField(opponent, "max_hp", 1);
        state.opp_energy = IntField(opponent, "energy", 0);
        state.opp_max_energy = IntField(opponent, "max_energy", 5);
        state.opp_ult = IntField(opponent, "ult", 0);
    }

    const bool applied = battle_hud_apply(&state);
    cJSON_Delete(root);
    if (applied) {
        g_last_seq = seq;
        ESP_LOGI(TAG, "frame seq=%d %s self=%d/%d e%d/%d ult%d opp=%d/%d e%d/%d ult%d cue=%s",
                 seq, expression.c_str(), state.hp, state.max_hp, state.energy, state.max_energy,
                 state.ult, state.opp_hp, state.opp_max_hp, state.opp_energy, state.opp_max_energy,
                 state.opp_ult, cue.empty() ? "-" : cue.c_str());
    }
    return applied;
}

// 一次拉取：POST JSON-RPC tools/call -> game_hud
void PullOnce(const std::string &url) {
    auto network = Board::GetInstance().GetNetwork();
    if (network == nullptr) {
        WarnThrottled("network not ready", 0);
        return;
    }
    auto http = network->CreateHttp(4);
    if (http == nullptr) {
        WarnThrottled("cannot create http", 0);
        return;
    }

    char body[256];
    std::snprintf(body, sizeof(body),
                  "{\"jsonrpc\":\"2.0\",\"id\":%d,\"method\":\"tools/call\","
                  "\"params\":{\"name\":\"game_hud\",\"arguments\":{\"wait_ms\":%d}}}",
                  ++g_request_id, kLongPollMs);

    http->SetTimeout(kHttpTimeoutMs);
    http->SetHeader("Content-Type", "application/json");
    http->SetHeader("Accept", "application/json, text/event-stream");
    std::string device_id = DeviceIdHeader();
    if (!device_id.empty()) {
        http->SetHeader("X-Linx-Device-Id", device_id);
    }
    http->SetKeepAlive(false);
    http->SetContent(std::string(body));

    if (!http->Open("POST", url)) {
        WarnThrottled("open failed", http->GetLastError());
        return;
    }

    const int status = http->GetStatusCode();
    std::string response = http->ReadAll();
    http->Close();

    if (status != 200) {
        WarnThrottled("unexpected status", status);
        return;
    }
    std::string hud_text = ExtractHudText(response);
    if (hud_text.empty()) {
        WarnThrottled("empty hud text", status);
        return;
    }
    ApplyHudJson(hud_text);
}

void PullTask(void *) {
    ESP_LOGI(TAG, "HUD pull task started");
    PullConfig config;
    while (true) {
        PullConfig current = LoadConfig();
        if (!current.enabled || current.url.empty()) {
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }
        if (current.url != config.url) {
            ESP_LOGI(TAG, "pull url -> %s", current.url.c_str());
            g_last_seq = -1;
        }
        config = current;

        // 网络与平台还没就绪时不要发请求：lwIP 的 tcpip 线程未起来会触发 assert
        const DeviceState state = Application::GetInstance().GetDeviceState();
        if (state == kDeviceStateStarting || state == kDeviceStateWifiConfiguring ||
            state == kDeviceStateActivating || state == kDeviceStateUpgrading) {
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }

        PullOnce(config.url);
        vTaskDelay(pdMS_TO_TICKS(kPollIntervalMs));
    }
}

// 配置工具：设置服务端地址并开关拉取（地址留空表示沿用已保存值）
void RegisterPullTool() {
    McpServer::GetInstance().AddTool(
        "self.hud.pull",
        "设置或查看设备从服务端拉取战斗画面的地址，并开关拉取。"
        "url 形如 http://192.168.1.10:3000/device/mcp；enabled 为 false 时停止拉取。",
        PropertyList({
            Property("url", kPropertyTypeString, ""),
            Property("enabled", kPropertyTypeBoolean, true),
        }),
        [](const PropertyList &properties) -> ReturnValue {
            const std::string url = properties["url"].value<std::string>();
            const bool enabled = properties["enabled"].value<bool>();
            char buffer[320];
            battle_pull_configure(url.c_str(), enabled, buffer, sizeof(buffer));
            return std::string(buffer);
        });
}
}  // namespace

bool battle_pull_apply_json(const char *json, size_t len) {
    if (json == nullptr || len == 0) {
        return false;
    }
    return ApplyHudJson(std::string(json, len));
}

bool battle_pull_configure(const char *url, bool enabled, char *out, size_t out_len) {
    Settings settings(kNamespace, true);
    std::string saved(url != nullptr ? url : "");
    if (!saved.empty()) {
        settings.SetString(kKeyUrl, saved);
    } else {
        saved = settings.GetString(kKeyUrl, "");
    }
    if (!saved.empty()) {
        settings.SetBool(kKeyEnabled, enabled);
    }
    g_last_seq = -1;
    g_last_warn_tick = 0;
    if (out != nullptr && out_len > 0) {
        std::snprintf(out, out_len, "{\"ok\":true,\"url\":\"%s\",\"enabled\":%s}",
                      saved.c_str(), enabled ? "true" : "false");
    }
    ESP_LOGI(TAG, "pull configured: url=%s enabled=%d", saved.c_str(), enabled ? 1 : 0);
    return !saved.empty();
}

void battle_pull_start(void) {
    RegisterPullTool();
    const BaseType_t ok = xTaskCreate(PullTask, "hud_pull", 6144, nullptr, 2, nullptr);
    ESP_LOGI(TAG, "pull task create=%d free_heap=%u", (int)ok, (unsigned)esp_get_free_heap_size());
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "pull task not created, HUD 拉取不可用");
    }
}
