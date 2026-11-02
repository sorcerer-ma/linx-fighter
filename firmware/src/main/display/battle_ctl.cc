// 战斗 HUD 控制通道：
// 1) USB Serial/JTAG 上的行式 JSON 命令（本机联调、出问题可远程排查）
// 2) 设备 MCP 工具 self.hud.*（平台智能体可调用，实现「状态改变通过 MCP 驱动」）
#include "battle_hud.h"
#include "gesture_hint.h"
#include "battle_link.h"
#include "battle_pull.h"
#include "panel_ctrl.h"

#include "application.h"
#include "board.h"
#include "display.h"
#include "dual_network_board.h"
#include "wifi_board.h"
#include "mcp_server.h"

#include <driver/usb_serial_jtag.h>
#include <driver/usb_serial_jtag_vfs.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <cJSON.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <esp_heap_caps.h>

// 当控制台就是 USB Serial/JTAG 时，输入输出走 VFS（stdin/stdout），
// 不能再安装 usb_serial_jtag 驱动，否则会抢同一份硬件。
#if defined(CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG)
#define HUD_USE_USB_CONSOLE 1
#else
#define HUD_USE_USB_CONSOLE 0
#endif

// 取屏能力默认关闭：整帧 15 万字节走 CDC，一旦主机读到一半断开，
// 阻塞写会把服务它的任务卡死（实测能把整机拖到没有任何输出）。
// 只在本机调试需要取图时才改成 1，并确保主机脚本一直读到 end。
// 截图用于联调取证：整帧约 150KB，走分块 base64 传输，单次 3 秒超时保护
#ifndef HUD_ENABLE_SCREENSHOT
#define HUD_ENABLE_SCREENSHOT 1
#endif

namespace {
constexpr char TAG[] = "BattleCtl";
constexpr int kLineMax = 640;

// 串口回复统一前缀，便于与 ESP_LOG 输出区分
constexpr char kReplyPrefix[] = "@@HUD ";

struct HudArgs {
    battle_hud_state_t state{};
    std::string expression;
    std::string cue;
    std::string mode;
};

bool ParseState(cJSON *params, HudArgs *out, std::string *error) {
    if (params == nullptr) {
        *error = "missing params";
        return false;
    }
    auto expr = cJSON_GetObjectItem(params, "expression");
    if (!cJSON_IsString(expr)) {
        *error = "expression must be string";
        return false;
    }
    out->expression = expr->valuestring;
    out->state.expression = out->expression.c_str();

    auto get_int = [params](const char *name, int fallback) -> int {
        auto item = cJSON_GetObjectItem(params, name);
        return cJSON_IsNumber(item) ? item->valueint : fallback;
    };
    out->state.hp = get_int("hp", 10);
    out->state.max_hp = get_int("max_hp", 10);
    out->state.energy = get_int("energy", 0);
    out->state.max_energy = get_int("max_energy", 5);
    out->state.ult = get_int("ult", 0);
    out->state.seq = get_int("seq", -1);
    out->state.hold_ms = get_int("hold_ms", 0);

    // 是否在战斗中：闲聊/未开局只画表情，不画资源
    auto battle = cJSON_GetObjectItem(params, "battle");
    out->state.battle = cJSON_IsBool(battle) ? cJSON_IsTrue(battle) : true;
    // 对局形态决定上排画谁：pvp 上排对手，solo 上排自己
    auto mode = cJSON_GetObjectItem(params, "mode");
    out->mode = (cJSON_IsString(mode) && mode->valuestring != nullptr) ? mode->valuestring : "pvp";
    out->state.mode = out->mode.c_str();

    // 对手资源：与自己的字段同构；没有对手时不下发这一块
    auto opponent = cJSON_GetObjectItem(params, "opponent");
    if (cJSON_IsObject(opponent)) {
        auto get_opp_int = [opponent](const char *name, int fallback) -> int {
            auto item = cJSON_GetObjectItem(opponent, name);
            return cJSON_IsNumber(item) ? item->valueint : fallback;
        };
        out->state.has_opponent = true;
        out->state.opp_hp = get_opp_int("hp", 10);
        out->state.opp_max_hp = get_opp_int("max_hp", 10);
        out->state.opp_energy = get_opp_int("energy", 0);
        out->state.opp_max_energy = get_opp_int("max_energy", 5);
        out->state.opp_ult = get_opp_int("ult", 0);
    }

    auto cue = cJSON_GetObjectItem(params, "cue");
    if (cJSON_IsString(cue)) {
        out->cue = cue->valuestring;
        out->state.cue = out->cue.c_str();
    }
    return true;
}

void FillDemoOpponent(battle_hud_state_t *state) {
    // 演示用对手数据：血量、能量与大招都和自己略有差异，便于一眼区分两行
    state->has_opponent = true;
    state->opp_max_hp = 14;
    state->opp_hp = state->hp < 10 ? 14 : 11;
    state->opp_max_energy = 5;
    state->opp_energy = state->energy > 0 ? state->energy - 1 : 2;
    state->opp_ult = state->hp < 10 ? 1 : 0;
}

void DemoTask(void *) {
    static const char *kOrder[] = {"neutral", "attack", "hurt", "guard",
                                   "dodge",   "ultready", "victory", "defeat"};
    int hp = 8;
    for (const char *expression : kOrder) {
        battle_hud_state_t state{};
        state.expression = expression;
        state.hp = hp;
        state.max_hp = 10;
        state.energy = (hp + 1) / 2;
        state.max_energy = 5;
        state.ult = strcmp(expression, "ultready") == 0 ? 1 : 0;
        state.seq = -1;
        state.cue = strcmp(expression, "neutral") == 0 ? nullptr : expression;
        state.hold_ms = 0;
        state.battle = true;
        state.mode = "pvp";
        FillDemoOpponent(&state);
        battle_hud_apply(&state);
        vTaskDelay(pdMS_TO_TICKS(900));
        hp = hp > 3 ? hp - 2 : 10;
    }
    // 演示结束后回到待命，避免屏幕定格在「失败」让人以为卡住
    battle_hud_state_t idle{};
    idle.expression = "neutral";
    idle.hp = 10;
    idle.max_hp = 10;
    idle.energy = 2;
    idle.max_energy = 5;
    idle.ult = 0;
    idle.seq = -1;
    idle.cue = nullptr;
    idle.hold_ms = 0;
    idle.battle = false;  // 演示结束回到闲聊态：资源收起、解锁平台情绪
    idle.mode = "pvp";
    battle_hud_apply(&idle);
    ESP_LOGI(TAG, "demo finished, resources hidden");
    vTaskDelete(nullptr);
}

size_t HudWrite(const uint8_t *data, size_t len) {
#if HUD_USE_USB_CONSOLE
    size_t n = fwrite(data, 1, len, stdout);
    fflush(stdout);
    return n;
#else
    int n = usb_serial_jtag_write_bytes(data, len, pdMS_TO_TICKS(1000));
    return n > 0 ? static_cast<size_t>(n) : 0;
#endif
}

void Reply(const char *line) {
    std::string out(kReplyPrefix);
    out += line;
    out += '\n';
    HudWrite(reinterpret_cast<const uint8_t *>(out.data()), out.size());
}


void WriteAll(const uint8_t *data, size_t len) {
    size_t off = 0;
    const TickType_t start = xTaskGetTickCount();
    while (off < len) {
        // 主机中途断开时不能无限重试：超时就把剩下的字节丢掉，保住整机
        if (xTaskGetTickCount() - start > pdMS_TO_TICKS(3000)) {
            ESP_LOGW(TAG, "usb write timeout, dropped %u bytes", static_cast<unsigned>(len - off));
            return;
        }
        // 分块写：一次 4KB，块间让出 1ms，避免 CDC 端没有及时取走导致丢字节
        size_t chunk = len - off > 4096 ? 4096 : len - off;
        size_t n = HudWrite(data + off, chunk);
        if (n == 0) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        off += n;
        if (n == chunk) {
            vTaskDelay(pdMS_TO_TICKS(1));
        }
    }
}

#if HUD_ENABLE_SCREENSHOT
// 截屏命令：按行分块传 base64，避免二进制流被 ESP_LOG 插行或 CDC 缓冲丢字节打乱
struct B64Chunk {
    int id;
    const uint8_t *data;
    int len;
};

void EmitShotChunk(int id, const uint8_t *data, size_t len) {
    static const char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) v |= static_cast<uint32_t>(data[i + 1]) << 8;
        if (i + 2 < len) v |= data[i + 2];
        out += kTable[(v >> 18) & 0x3F];
        out += kTable[(v >> 12) & 0x3F];
        out += (i + 1 < len) ? kTable[(v >> 6) & 0x3F] : '=';
        out += (i + 2 < len) ? kTable[v & 0x3F] : '=';
    }
    std::string line = "{\"id\":";
    line += std::to_string(id);
    line += ",\"shot\":\"";
    line += out;
    line += "\"}\n";
    WriteAll(reinterpret_cast<const uint8_t *>(line.data()), line.size());
}

void HandleScreenshot(int request_id) {
    uint8_t *data = nullptr;
    size_t len = 0;
    int w = 0;
    int h = 0;
    if (!battle_hud_snapshot(&data, &len, &w, &h)) {
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"error\":\"snapshot failed\"}", request_id);
        Reply(buf);
        return;
    }
    char head[128];
    snprintf(head, sizeof(head), "{\"id\":%d,\"result\":\"shot\",\"w\":%d,\"h\":%d,\"cf\":\"RGB565\",\"len\":%u}",
             request_id, w, h, static_cast<unsigned>(len));
    Reply(head);
    constexpr size_t kChunk = 1024;
    for (size_t off = 0; off < len; off += kChunk) {
        size_t n = len - off > kChunk ? kChunk : len - off;
        EmitShotChunk(request_id, data + off, n);
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    char done[64];
    snprintf(done, sizeof(done), "{\"id\":%d,\"shot\":\"end\",\"total\":%u}", request_id,
             static_cast<unsigned>(len));
    Reply(done);
    heap_caps_free(data);
    ESP_LOGI(TAG, "screenshot %dx%d %u bytes", w, h, static_cast<unsigned>(len));
}


#endif  // HUD_ENABLE_SCREENSHOT

// 单行 JSON 输出（MCP 响应不带 @@HUD 前缀，便于标准 MCP 客户端直接解析）
void PrintJsonLine(cJSON *obj) {
    char *text = cJSON_PrintUnformatted(obj);
    if (text == nullptr) {
        return;
    }
    std::string line(text);
    line += '\n';
    HudWrite(reinterpret_cast<const uint8_t *>(line.data()), line.size());
    cJSON_free(text);
}

// 把参数应用到 HUD，成功返回 true，并给出简短结果文本
bool ApplyStateFromParams(cJSON *params, std::string *text_out) {
    HudArgs args;
    std::string error;
    if (!ParseState(params, &args, &error)) {
        if (text_out != nullptr) {
            *text_out = "{\"ok\":false,\"reason\":\"" + error + "\"}";
        }
        return false;
    }
    bool ok = battle_hud_apply(&args.state);
    if (text_out != nullptr) {
        *text_out = ok ? "{\"ok\":true}" : "{\"ok\":false,\"reason\":\"invalid expression\"}";
    }
    return ok;
}

const char kToolsListJson[] =
    "[{\"name\":\"self.hud.set_state\",\"description\":\"显示战斗状态：表情、生命条、能量闪电、大招徽记，并按 cue 播放音效\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
    "\"expression\":{\"type\":\"string\",\"enum\":[\"neutral\",\"attack\",\"hurt\",\"guard\",\"dodge\",\"ultready\",\"victory\",\"defeat\",\"charge\",\"heavy\",\"surprised\",\"kiss\",\"thinking\",\"sleep\"]},"
    "\"hp\":{\"type\":\"integer\"},\"max_hp\":{\"type\":\"integer\"},"
    "\"energy\":{\"type\":\"integer\"},\"max_energy\":{\"type\":\"integer\"},"
    "\"ult\":{\"type\":\"integer\",\"enum\":[0,1,2]},"
    "\"battle\":{\"type\":\"boolean\",\"description\":\"是否在战斗中；false 时只显示表情\"},"
    "\"mode\":{\"type\":\"string\",\"enum\":[\"solo\",\"pvp\"],\"description\":\"对局形态：pvp 上排对手，solo 上排自己\"},"
    "\"cue\":{\"type\":\"string\"},\"hold_ms\":{\"type\":\"integer\"},\"seq\":{\"type\":\"integer\"},"
    "\"opponent\":{\"type\":\"object\",\"description\":\"对面玩家的资源；两块屏相对摆放时显示在上排\","
    "\"properties\":{\"hp\":{\"type\":\"integer\"},\"max_hp\":{\"type\":\"integer\"},"
    "\"energy\":{\"type\":\"integer\"},\"max_energy\":{\"type\":\"integer\"},"
    "\"ult\":{\"type\":\"integer\",\"enum\":[0,1,2]}}}},"
    "\"required\":[\"expression\"]}},"
    "{\"name\":\"self.hud.get_state\",\"description\":\"读取当前 HUD 状态\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
    "{\"name\":\"self.hud.demo\",\"description\":\"依次演示 8 种表情与音效\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"
    "{\"name\":\"self.hud.invert\",\"description\":\"面板颜色反转开关（不同批次 ST7789 屏 INVOFF/INVON 相反）\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"enable\":{\"type\":\"boolean\"}}}},"
    "{\"name\":\"self.hud.emotion\",\"description\":\"按平台情绪名切换日常表情（如 kissy/thinking/sleepy），用于验证情绪映射\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}},"
    "{\"name\":\"self.hud.gesture\",\"description\":\"按一句话识别明确动作并切换表情（如 飞吻 → kissy），用于验证关键词兜底\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}},"
    "{\"name\":\"self.hud.pull\",\"description\":\"设置从服务端拉取战斗画面的地址并开关\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"},"
    "\"enabled\":{\"type\":\"boolean\"}}}},"
    "{\"name\":\"self.hud.link\",\"description\":\"设置服务端推送战斗画面的 WebSocket 地址并开关（优先于拉取）\","
    "\"inputSchema\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"},"
    "\"enabled\":{\"type\":\"boolean\"}}}}]";

// MCP JSON-RPC：initialize / notifications/initialized / tools/list / tools/call / ping
void HandleMcp(cJSON *root) {
    auto method = cJSON_GetObjectItem(root, "method");
    auto id = cJSON_GetObjectItem(root, "id");
    if (!cJSON_IsString(method)) {
        return;
    }
    const char *m = method->valuestring;

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddStringToObject(resp, "jsonrpc", "2.0");
    if (id != nullptr) {
        cJSON_AddItemToObject(resp, "id", cJSON_Duplicate(id, true));
    }

    if (strcmp(m, "initialize") == 0) {
        cJSON *result = cJSON_AddObjectToObject(resp, "result");
        cJSON_AddStringToObject(result, "protocolVersion", "2024-11-05");
        cJSON *caps = cJSON_AddObjectToObject(result, "capabilities");
        cJSON_AddObjectToObject(caps, "tools");
        cJSON *info = cJSON_AddObjectToObject(result, "serverInfo");
        cJSON_AddStringToObject(info, "name", "yunliao-s3-hud");
        cJSON_AddStringToObject(info, "version", "0.1.0");
    } else if (strcmp(m, "notifications/initialized") == 0) {
        cJSON_Delete(resp);
        return;  // 通知不需要响应
    } else if (strcmp(m, "tools/list") == 0) {
        cJSON *result = cJSON_AddObjectToObject(resp, "result");
        cJSON_AddItemToObject(result, "tools", cJSON_Parse(kToolsListJson));
    } else if (strcmp(m, "tools/call") == 0) {
        auto params = cJSON_GetObjectItem(root, "params");
        auto name = cJSON_GetObjectItem(params, "name");
        auto args = cJSON_GetObjectItem(params, "arguments");
        std::string text = "{\"ok\":false,\"reason\":\"unknown tool\"}";
        bool is_error = false;
        if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.set_state") == 0) {
            is_error = !ApplyStateFromParams(args, &text);
        } else if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.get_state") == 0) {
            char state[512];
            battle_hud_get_state_json(state, sizeof(state));
            text = state;
        } else if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.demo") == 0) {
            battle_demo_start();
            text = "{\"ok\":true,\"result\":\"demo started\"}";
        } else if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.pull") == 0) {
            const cJSON *url = cJSON_GetObjectItemCaseSensitive(args, "url");
            const cJSON *en = cJSON_GetObjectItemCaseSensitive(args, "enabled");
            char buffer[320];
            battle_pull_configure(cJSON_IsString(url) ? url->valuestring : "",
                                  cJSON_IsBool(en) ? cJSON_IsTrue(en) : true, buffer, sizeof(buffer));
            text = buffer;
        } else if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.link") == 0) {
            const cJSON *url = cJSON_GetObjectItemCaseSensitive(args, "url");
            const cJSON *en = cJSON_GetObjectItemCaseSensitive(args, "enabled");
            char buffer[320];
            const bool ok = battle_link_configure(cJSON_IsString(url) ? url->valuestring : "",
                                                  cJSON_IsBool(en) ? cJSON_IsTrue(en) : true,
                                                  buffer, sizeof(buffer));
            text = ok ? std::string("{\"ok\":true,\"url\":\"") + buffer + "\"}"
                      : "{\"ok\":false,\"reason\":\"invalid url\"}";
            is_error = !ok;
        } else if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.emotion") == 0) {
            // 直接走平台的 SetEmotion 入口，用于在没有平台链路时验证「情绪 → 表情」映射
            const cJSON *emo = cJSON_GetObjectItemCaseSensitive(args, "name");
            const bool has_emo = cJSON_IsString(emo) && emo->valuestring[0] != '\0';
            if (has_emo) {
                Board::GetInstance().GetDisplay()->SetEmotion(emo->valuestring);
                text = std::string("{\"ok\":true,\"emotion\":\"") + emo->valuestring + "\"}";
            } else {
                text = "{\"ok\":false,\"reason\":\"missing name\"}";
            }
            is_error = !has_emo;
        } else if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.gesture") == 0) {
            // 用一句话走一遍关键词兜底：命中即切到对应表情，用于没有平台链路时验证
            const cJSON *txt = cJSON_GetObjectItemCaseSensitive(args, "text");
            const char *hint = cJSON_IsString(txt) ? gesture_hint_from_text(txt->valuestring) : nullptr;
            if (hint != nullptr) {
                Board::GetInstance().GetDisplay()->SetEmotion(hint);
                text = std::string("{\"ok\":true,\"hint\":\"") + hint + "\"}";
            } else {
                text = "{\"ok\":false,\"reason\":\"no gesture keyword\"}";
                is_error = true;
            }
        } else if (cJSON_IsString(name) && strcmp(name->valuestring, "self.hud.invert") == 0) {
            const cJSON *en = cJSON_GetObjectItemCaseSensitive(args, "enable");
            const bool on = cJSON_IsBool(en) ? cJSON_IsTrue(en) : true;
            const bool done = panel_ctrl_invert(on);
            text = done ? (on ? "{\"ok\":true,\"inverted\":true}" : "{\"ok\":true,\"inverted\":false}")
                        : "{\"ok\":false,\"reason\":\"panel not ready\"}";
            is_error = !done;
        } else {
            is_error = true;
        }
        cJSON *result = cJSON_AddObjectToObject(resp, "result");
        cJSON *content = cJSON_AddArrayToObject(result, "content");
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "type", "text");
        cJSON_AddStringToObject(item, "text", text.c_str());
        cJSON_AddItemToArray(content, item);
        cJSON_AddBoolToObject(result, "isError", is_error);
    } else if (strcmp(m, "ping") == 0) {
        cJSON_AddObjectToObject(resp, "result");
    } else {
        cJSON *error = cJSON_AddObjectToObject(resp, "error");
        cJSON_AddNumberToObject(error, "code", -32601);
        cJSON_AddStringToObject(error, "message", "method not found");
    }

    if (id != nullptr) {
        PrintJsonLine(resp);
    }
    cJSON_Delete(resp);
}

void HandleCommand(cJSON *root) {
    auto id = cJSON_GetObjectItem(root, "id");
    int request_id = cJSON_IsNumber(id) ? id->valueint : 0;
    auto method = cJSON_GetObjectItem(root, "method");
    auto params = cJSON_GetObjectItem(root, "params");
    if (!cJSON_IsString(method)) {
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"error\":\"missing method\"}", request_id);
        Reply(buf);
        return;
    }

    if (strcmp(method->valuestring, "hud.set_state") == 0) {
        std::string text;
        ApplyStateFromParams(params, &text);
        char buf[256];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":%s}", request_id, text.c_str());
        Reply(buf);
    } else if (strcmp(method->valuestring, "hud.get_state") == 0) {
        char state[256];
        battle_hud_get_state_json(state, sizeof(state));
        char buf[320];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":%s}", request_id, state);
        Reply(buf);
    } else if (strcmp(method->valuestring, "hud.pull") == 0) {
        const cJSON *url = cJSON_GetObjectItemCaseSensitive(root, "url");
        const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(root, "enabled");
        char buffer[320];
        battle_pull_configure(cJSON_IsString(url) ? url->valuestring : "",
                              cJSON_IsBool(enabled) ? cJSON_IsTrue(enabled) : true,
                              buffer, sizeof(buffer));
        char buf[380];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":%s}", request_id, buffer);
        Reply(buf);
    } else if (strcmp(method->valuestring, "hud.cfg") == 0) {
        // 调试用：进入/退出 WiFi 配网模式，等价于三击按键
        const cJSON *enable = cJSON_GetObjectItemCaseSensitive(root, "enable");
        const bool on = cJSON_IsBool(enable) ? cJSON_IsTrue(enable) : true;
        auto &dual = static_cast<DualNetworkBoard &>(Board::GetInstance());
        if (on) {
            static_cast<WifiBoard &>(dual.GetCurrentBoard()).EnterWifiConfigMode();
        } else {
            dual.GetCurrentBoard().ExitWifiConfigMode();
        }
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":{\"ok\":true}}", request_id);
        Reply(buf);
    } else if (strcmp(method->valuestring, "hud.sysui") == 0) {
        // 调试用：直接切换系统界面（配网/激活时的原始状态栏），验证 HUD 让位逻辑
        const cJSON *enable = cJSON_GetObjectItemCaseSensitive(root, "enable");
        const bool on = cJSON_IsBool(enable) ? cJSON_IsTrue(enable) : true;
        Board::GetInstance().GetDisplay()->ShowSystemUi(on);
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":{\"ok\":true,\"system_ui\":%s}}",
                 request_id, on ? "true" : "false");
        Reply(buf);
    } else if (strcmp(method->valuestring, "hud.invert") == 0) {
        const cJSON *enable = cJSON_GetObjectItemCaseSensitive(root, "enable");
        const bool on = cJSON_IsBool(enable) ? cJSON_IsTrue(enable) : true;
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":%s}", request_id,
                 panel_ctrl_invert(on) ? "true" : "false");
        Reply(buf);
    } else if (strcmp(method->valuestring, "hud.unlock") == 0) {
        battle_hud_unlock();
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":\"ok\"}", request_id);
        Reply(buf);
    } else if (strcmp(method->valuestring, "hud.demo") == 0) {
        xTaskCreate(DemoTask, "hud_demo", 4096, nullptr, 1, nullptr);
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":\"demo started\"}", request_id);
        Reply(buf);
#if HUD_ENABLE_SCREENSHOT
    } else if (strcmp(method->valuestring, "hud.screenshot") == 0) {
        HandleScreenshot(request_id);
#endif
    } else if (strcmp(method->valuestring, "ping") == 0) {
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"result\":\"pong\"}", request_id);
        Reply(buf);
    } else {
        char buf[128];
        snprintf(buf, sizeof(buf), "{\"id\":%d,\"error\":\"unknown method\"}", request_id);
        Reply(buf);
    }
}

void ControlTask(void *) {
    char line[kLineMax];
    int line_len = 0;

#if !HUD_USE_USB_CONSOLE
    // 控制台不是 USB Serial/JTAG 时由这里接管驱动；是控制台时让 VFS 独占，避免抢硬件
    usb_serial_jtag_driver_config_t config{};
    config.tx_buffer_size = 8192;
    config.rx_buffer_size = 4096;
    esp_err_t err = usb_serial_jtag_driver_install(&config);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "usb_serial_jtag_driver_install failed: %s", esp_err_to_name(err));
        vTaskDelete(nullptr);
        return;
    }
#endif

    // 启动横幅：主机脚本以此为握手信号
    Reply("{\"event\":\"ready\",\"protocol\":\"hud-jsonl/1\"}");
    ESP_LOGI(TAG, "control channel ready on USB Serial/JTAG");

    while (true) {
        uint8_t chunk[128];
#if HUD_USE_USB_CONSOLE
        ssize_t n = read(STDIN_FILENO, chunk, sizeof(chunk));
        if (n <= 0) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        int got = static_cast<int>(n);
#else
        int got = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(50));
#endif
        for (int i = 0; i < got; ++i) {
            char c = static_cast<char>(chunk[i]);
            if (c == '\r') {
                continue;
            }
            if (c == '\n') {
                line[line_len] = '\0';
                if (line_len > 0) {
                    cJSON *root = cJSON_Parse(line);
                    if (root == nullptr) {
                        Reply("{\"id\":0,\"error\":\"invalid json\"}");
                    } else {
                        auto jr = cJSON_GetObjectItem(root, "jsonrpc");
                        if (cJSON_IsString(jr) && strcmp(jr->valuestring, "2.0") == 0) {
                            HandleMcp(root);
                        } else {
                            HandleCommand(root);
                        }
                        cJSON_Delete(root);
                    }
                }
                line_len = 0;
                continue;
            }
            if (line_len < kLineMax - 1) {
                line[line_len++] = c;
            } else {
                line_len = 0;  // 超长行直接丢弃，避免污染后续命令
            }
        }
    }
}

// MCP 工具：把平台智能体的调用映射到同一套 HUD 状态
Property HudIntegerProperty(const char *name, int default_value, int min_value, int max_value) {
    return Property(name, kPropertyTypeInteger, default_value, min_value, max_value);
}
}  // namespace

void battle_demo_start() {
    xTaskCreate(DemoTask, "hud_demo", 4096, nullptr, 1, nullptr);
}

void battle_mcp_register() {
    auto &server = McpServer::GetInstance();

    server.AddTool(
        "self.hud.set_state",
        "显示战斗状态：表情、生命条、能量闪电、大招徽记，并可播放音效。仅在收到服务端战斗状态时调用。",
        PropertyList({Property("expression", kPropertyTypeString),
                      HudIntegerProperty("hp", 10, 0, 999),
                      HudIntegerProperty("max_hp", 10, 1, 999),
                      HudIntegerProperty("energy", 0, 0, 5),
                      HudIntegerProperty("max_energy", 5, 0, 5),
                      HudIntegerProperty("ult", 0, 0, 2),
                      HudIntegerProperty("seq", 0, 0, 999999),
                      Property("cue", kPropertyTypeString, std::string{}),
                      HudIntegerProperty("hold_ms", 0, 0, 60000)}),
        [](const PropertyList &properties) -> ReturnValue {
            battle_hud_state_t state{};
            // 注意：value<std::string>() 返回副本，这里必须用局部变量承接生命周期
            std::string expression = properties["expression"].value<std::string>();
            std::string cue = properties["cue"].value<std::string>();
            state.expression = expression.c_str();
            state.hp = properties["hp"].value<int>();
            state.max_hp = properties["max_hp"].value<int>();
            state.energy = properties["energy"].value<int>();
            state.max_energy = properties["max_energy"].value<int>();
            state.ult = properties["ult"].value<int>();
            state.seq = properties["seq"].value<int>();
            state.hold_ms = properties["hold_ms"].value<int>();
            state.cue = cue.c_str();
            if (!battle_hud_apply(&state)) {
                return std::string("{\"ok\":false,\"reason\":\"invalid expression\"}");
            }
            return std::string("{\"ok\":true}");
        });

    server.AddTool("self.hud.get_state", "读取设备当前战斗界面状态（表情/生命/能量/大招/音效）。",
                   PropertyList(), [](const PropertyList &) -> ReturnValue {
                       char state[512];
                       battle_hud_get_state_json(state, sizeof(state));
                       return std::string(state);
                   });

    server.AddTool("self.hud.demo", "依次演示 8 种表情与对应音效，用于真机自检。",
                   PropertyList(), [](const PropertyList &) -> ReturnValue {
                       battle_demo_start();
                       return true;
                   });

    server.AddTool("self.hud.link",
                   "设置服务端推送战斗画面的 WebSocket 地址并开关。url 形如 ws://host:port/device/ws；"
                   "enabled 为 false 时断开推送。启用推送会自动关闭拉取。",
                   PropertyList({Property("url", kPropertyTypeString, ""),
                                 Property("enabled", kPropertyTypeBoolean, true)}),
                   [](const PropertyList &properties) -> ReturnValue {
                       std::string url = properties["url"].value<std::string>();
                       const bool enabled = properties["enabled"].value<bool>();
                       char buffer[320];
                       if (!battle_link_configure(url.c_str(), enabled, buffer, sizeof(buffer))) {
                           return std::string("{\"ok\":false,\"reason\":\"invalid url\"}");
                       }
                       return std::string("{\"ok\":true,\"url\":\"") + buffer + "\"}";
                   });
}

void battle_ctl_start() {
    battle_mcp_register();
    ESP_LOGI(TAG, "HUD MCP tools registered: set_state / get_state / demo / link");
    xTaskCreate(ControlTask, "battle_ctl", 8192, nullptr, 2, nullptr);
}
