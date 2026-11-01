// 战斗 HUD 渲染层：8 表情、生命条、5 闪电能量、大招徽记三态
#include "battle_hud.h"
#include "battle_assets.h"
#include "face_view.h"

#include "application.h"
#include "board.h"
#include "display.h"
#include "assets/lang_config.h"

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <cstdio>
#include <cstring>
#include <functional>
#include <optional>
#include <string_view>

namespace {
constexpr char TAG[] = "BattleHud";

// 颜色沿用移动端原型（docs/product/prototypes/mobile-companion.html）
constexpr uint32_t kHpTrackColor = 0x223A2C;
constexpr uint32_t kHpColor = 0x7FC98A;
constexpr uint32_t kHpLowColor = 0xE0A34A;

lv_obj_t *root_ = nullptr;
lv_timer_t *hold_timer_ = nullptr;

// 一屏两行资源：上排=对面玩家，下排=自己；每行都是「爱心+数字+血条+5 闪电+数字」
struct ResourceRow {
    lv_obj_t *heart = nullptr;
    lv_obj_t *hp_label = nullptr;
    lv_obj_t *hp_track = nullptr;
    lv_obj_t *hp_fill = nullptr;
    lv_obj_t *energy_icons[5] = {};
};
ResourceRow rows_[2];
// 大招徽记：左上=对面，右上=自己（两块屏相对摆放时两边都能看到对方的大招）
lv_obj_t *ult_left_ = nullptr;
lv_obj_t *ult_right_ = nullptr;

// 行内布局（行高 14px：数字只写当前生命值、能量只画闪电，避免占高度）
constexpr int kRowY[2] = {190, 212};      // 上排对手 / 下排自己
constexpr int kHeartX = 8;
constexpr int kHpLabelX = 27;
constexpr int kHpTrackX = 50;
constexpr int kHpTrackW = 164;            // 血条拉通整行，和最初单行版一样占满底部
constexpr int kHpFillInnerW = 158;
constexpr int kBoltsX = 224;              // 5 闪电贴右边对齐（末颗收在 314）
constexpr int kBoltsStep = 19;
constexpr uint32_t kSelfTextColor = 0xD6F9B6;
constexpr uint32_t kOpponentTextColor = 0xC0D6B8;

char current_expression_[16] = "neutral";
char current_cue_[16] = "";
int current_hp_ = 10;
int current_max_hp_ = 10;
int current_energy_ = 0;
int current_max_energy_ = 5;
int current_ult_ = 0;
int current_seq_ = -1;
int current_hold_ms_ = 0;
bool locked_ = false;
bool current_battle_ = false;  // 开机先把资源区收起来，等第一帧事实到达再显示
char current_mode_[8] = "pvp";
bool current_has_opponent_ = false;
int current_opp_hp_ = 0;
int current_opp_max_hp_ = 1;
int current_opp_energy_ = 0;
int current_opp_max_energy_ = 5;
int current_opp_ult_ = 0;

// LVGL 只在持有显示锁时访问；串口任务与主任务共用同一把递归锁
// 显示对象由 battle_hud_create() 显式注入：板级构造期间 Board 单例仍处于
// 初始化中，此时再调用 Board::GetInstance() 会递归等待静态初始化保护而挂死。
Display* g_display = nullptr;

class HudLock {
public:
    HudLock() {
        if (g_display != nullptr) {
            guard_.emplace(g_display);
        }
    }

private:
    std::optional<DisplayLockGuard> guard_;
};

int Clamp(int value, int low, int high) {
    return value < low ? low : (value > high ? high : value);
}

bool IsKnownExpression(const char *name) {
    return face_expression_from_name(name) >= 0;
}

void ApplyExpression(const char *name) {
    int expr = face_expression_from_name(name);
    if (expr < 0) {
        ESP_LOGW(TAG, "unknown expression: %s", name ? name : "(null)");
        return;
    }
    face_view_set(expr, true);
    snprintf(current_expression_, sizeof(current_expression_), "%s", name);
}

void SetUltIcon(lv_obj_t *icon, int ult) {
    if (icon == nullptr) {
        return;
    }
    switch (ult) {
        case 1:
            lv_image_set_src(icon, &ult_ready);
            break;
        case 2:
            lv_image_set_src(icon, &ult_used);
            break;
        default:
            lv_image_set_src(icon, &ult_idle);
            break;
    }
}

// 画一行资源；visible=false 时整行隐藏（单人等待对手加入时只有自己那一行）
void ApplyRow(ResourceRow &row, bool visible, int hp, int max_hp, int energy, int max_energy,
              uint32_t text_color) {
    lv_obj_t *all[] = {row.heart, row.hp_label, row.hp_track};
    for (lv_obj_t *obj : all) {
        if (obj == nullptr) {
            continue;
        }
        if (visible) {
            lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
        }
    }
    for (lv_obj_t *icon : row.energy_icons) {
        if (icon != nullptr) {
            lv_obj_add_flag(icon, LV_OBJ_FLAG_HIDDEN);
        }
    }
    if (!visible || row.hp_fill == nullptr) {
        return;
    }

    // 生命条：按比例填充，低血量改琥珀色；数字给出准确值（如 13/14）
    int ratio_hp = max_hp > 0 ? Clamp(hp * 100 / max_hp, 0, 100) : 0;
    lv_obj_set_width(row.hp_fill, kHpFillInnerW * ratio_hp / 100);
    lv_obj_set_style_bg_color(row.hp_fill, lv_color_hex(ratio_hp <= 30 ? kHpLowColor : kHpColor), 0);
    // 只写当前生命值：上限由血条长度表达，不再堆「14/14」这种总数
    lv_label_set_text_fmt(row.hp_label, "%d", hp);
    lv_obj_set_style_text_color(row.hp_label, lv_color_hex(text_color), 0);

    // 能量：min(max_energy,5) 个闪电，点评亮，数字给出准确值（如 3/5）
    const int max_icons = static_cast<int>(sizeof(row.energy_icons) / sizeof(row.energy_icons[0]));
    for (int i = 0; i < max_icons; ++i) {
        if (row.energy_icons[i] == nullptr) {
            continue;
        }
        if (i < max_energy) {
            lv_obj_remove_flag(row.energy_icons[i], LV_OBJ_FLAG_HIDDEN);
            lv_image_set_src(row.energy_icons[i], i < energy ? &icon_bolt_on : &icon_bolt_off);
        } else {
            lv_obj_add_flag(row.energy_icons[i], LV_OBJ_FLAG_HIDDEN);
        }
    }
}

// 一行资源的两个来源：自己或对面
struct SideView {
    bool visible;
    int hp;
    int max_hp;
    int energy;
    int max_energy;
    int ult;
    uint32_t color;
};

void HideAllResources() {
    for (ResourceRow &row : rows_) {
        ApplyRow(row, false, 0, 1, 0, 5, kSelfTextColor);
    }
    if (ult_left_ != nullptr) {
        lv_obj_add_flag(ult_left_, LV_OBJ_FLAG_HIDDEN);
    }
    if (ult_right_ != nullptr) {
        lv_obj_add_flag(ult_right_, LV_OBJ_FLAG_HIDDEN);
    }
}

void ApplyResources() {
    if (rows_[1].hp_fill == nullptr) {
        return;
    }
    // 闲聊/未开局只留表情：生命值、能量、大招全部不显示
    if (!current_battle_) {
        HideAllResources();
        return;
    }

    const SideView self{true, current_hp_, current_max_hp_, current_energy_, current_max_energy_,
                        current_ult_, kSelfTextColor};
    const SideView opponent{current_has_opponent_, current_opp_hp_, current_opp_max_hp_,
                            current_opp_energy_, current_opp_max_energy_, current_opp_ult_,
                            kOpponentTextColor};

    // 上排永远是「看屏幕的人」：双人房两块屏相对，看屏的是对面玩家，所以上排是对手；
    // 单人局看屏的是本人，所以上排换成自己。
    const bool pvp = strcmp(current_mode_, "solo") != 0;
    const SideView &top = pvp ? opponent : self;
    const SideView &bottom = pvp ? self : opponent;

    ApplyRow(rows_[0], top.visible, top.hp, top.max_hp, top.energy, top.max_energy, top.color);
    ApplyRow(rows_[1], bottom.visible, bottom.hp, bottom.max_hp, bottom.energy, bottom.max_energy,
             bottom.color);

    if (ult_left_ != nullptr) {
        if (top.visible) {
            lv_obj_remove_flag(ult_left_, LV_OBJ_FLAG_HIDDEN);
            SetUltIcon(ult_left_, top.ult);
        } else {
            lv_obj_add_flag(ult_left_, LV_OBJ_FLAG_HIDDEN);
        }
    }
    if (ult_right_ != nullptr) {
        if (bottom.visible) {
            lv_obj_remove_flag(ult_right_, LV_OBJ_FLAG_HIDDEN);
            SetUltIcon(ult_right_, bottom.ult);
        } else {
            lv_obj_add_flag(ult_right_, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

void HoldTimerCallback(lv_timer_t *timer) {
    (void)timer;
    hold_timer_ = nullptr;
    // 短时表情（受击/闪避）结束后回到待命，避免定格
    ApplyExpression("neutral");
}

void ScheduleExpressionHold(int hold_ms) {
    if (hold_timer_ != nullptr) {
        lv_timer_delete(hold_timer_);
        hold_timer_ = nullptr;
    }
    if (hold_ms <= 0) {
        return;
    }
    hold_timer_ = lv_timer_create(HoldTimerCallback, hold_ms, nullptr);
    lv_timer_set_repeat_count(hold_timer_, 1);
}

const std::string_view *FindCue(const char *cue) {
    if (cue == nullptr) {
        return nullptr;
    }
    // 兼容表情名与音效名两套写法：演示/服务端都按表情名下发
    // 待命不配音：静默即「待命」的听觉标识
    if (strcmp(cue, "neutral") == 0) return nullptr;
    if (strcmp(cue, "ultready") == 0) return &Lang::Sounds::OGG_ULT;
    if (strcmp(cue, "attack") == 0) return &Lang::Sounds::OGG_ATTACK;
    if (strcmp(cue, "hurt") == 0) return &Lang::Sounds::OGG_HURT;
    if (strcmp(cue, "guard") == 0) return &Lang::Sounds::OGG_GUARD;
    if (strcmp(cue, "dodge") == 0) return &Lang::Sounds::OGG_DODGE;
    if (strcmp(cue, "ult") == 0) return &Lang::Sounds::OGG_ULT;
    if (strcmp(cue, "victory") == 0) return &Lang::Sounds::OGG_VICTORY;
    if (strcmp(cue, "defeat") == 0) return &Lang::Sounds::OGG_DEFEAT;
    return nullptr;
}
}  // namespace

// 未进入对局时的默认表情：没在收听就显示休眠脸，打开收听（唤醒/连接）后回到待命脸。
// 有明确聊天情绪（如 kiss/thinking）时以情绪为准，由平台 SetEmotion 驱动。
const char *IdleExpression() {
    const DeviceState state = Application::GetInstance().GetDeviceState();
    if (state == kDeviceStateIdle || state == kDeviceStateStarting ||
        state == kDeviceStateWifiConfiguring || state == kDeviceStateActivating) {
        return "sleep";
    }
    return "neutral";
}

// 设备状态切换时刷新默认表情，保证「休眠 <-> 待命」跟随收听状态
void StateFaceTask(void *arg) {
    (void)arg;
    DeviceState last = kDeviceStateUnknown;
    bool last_system_ui = false;
    for (;;) {
        const DeviceState cur = Application::GetInstance().GetDeviceState();
        // 配网/激活/升级时需要整屏显示原始提示文字：隐藏战斗 HUD，交给原始状态栏
        const bool system_ui = (cur == kDeviceStateWifiConfiguring || cur == kDeviceStateActivating ||
                                cur == kDeviceStateUpgrading);
        if (system_ui != last_system_ui) {
            last_system_ui = system_ui;
            battle_hud_set_overlay_visible(!system_ui);
            Board::GetInstance().GetDisplay()->ShowSystemUi(system_ui);
        }
        if (!battle_hud_is_locked()) {
            const DeviceState state = cur;
            if (state != last) {
                last = state;
                if (state == kDeviceStateIdle || state == kDeviceStateStarting ||
                    state == kDeviceStateWifiConfiguring || state == kDeviceStateActivating) {
                    battle_hud_set_expression("sleep", 0);
                } else if (state == kDeviceStateListening || state == kDeviceStateConnecting) {
                    battle_hud_set_expression("neutral", 0);
                }
            }
        } else {
            // 战斗中不理会设备状态；这里只同步当前状态，避免解锁瞬间把
            // 手动下发的聊天表情（kiss/thinking 等）立刻改回休眠。
            last = Application::GetInstance().GetDeviceState();
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

void battle_hud_create(Display* display) {
    g_display = display;
    HudLock lock;
    if (root_ != nullptr) {
        return;
    }

    // HUD 根层：透明、不可点击，覆盖在隐藏后的原界面上
    root_ = lv_obj_create(lv_screen_active());
    lv_obj_set_size(root_, lv_display_get_horizontal_resolution(nullptr),
                    lv_display_get_vertical_resolution(nullptr));
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_remove_flag(root_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(root_, LV_OBJ_FLAG_CLICKABLE);

    // 表情：矢量绘制，背景铺满整屏（设计稿要求底色全屏）
    face_view_create(root_);

    // 两行资源：上排对手、下排自己；每行「爱心 + hp 数字 + 血条 + 5 闪电 + 能量数字」
    for (int row = 0; row < 2; ++row) {
        const int y = kRowY[row];
        ResourceRow &r = rows_[row];

        r.heart = lv_image_create(root_);
        lv_image_set_src(r.heart, &icon_heart);
        lv_obj_set_pos(r.heart, kHeartX, y + 1);

        r.hp_label = lv_label_create(root_);
        lv_label_set_text(r.hp_label, "10");
        lv_obj_set_pos(r.hp_label, kHpLabelX, y - 3);
        lv_obj_set_style_text_font(r.hp_label, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(r.hp_label, lv_color_hex(kSelfTextColor), 0);

        r.hp_track = lv_obj_create(root_);
        lv_obj_set_size(r.hp_track, kHpTrackW, 12);
        lv_obj_set_pos(r.hp_track, kHpTrackX, y + 1);
        lv_obj_set_style_radius(r.hp_track, 6, 0);
        lv_obj_set_style_bg_color(r.hp_track, lv_color_hex(kHpTrackColor), 0);
        lv_obj_set_style_bg_opa(r.hp_track, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(r.hp_track, 0, 0);
        lv_obj_set_style_pad_all(r.hp_track, 0, 0);
        lv_obj_remove_flag(r.hp_track, LV_OBJ_FLAG_SCROLLABLE);

        r.hp_fill = lv_obj_create(r.hp_track);
        lv_obj_set_size(r.hp_fill, kHpFillInnerW, 8);
        lv_obj_set_pos(r.hp_fill, 3, 2);
        lv_obj_set_style_radius(r.hp_fill, 4, 0);
        lv_obj_set_style_bg_color(r.hp_fill, lv_color_hex(kHpColor), 0);
        lv_obj_set_style_bg_opa(r.hp_fill, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(r.hp_fill, 0, 0);

        for (int i = 0; i < 5; ++i) {
            r.energy_icons[i] = lv_image_create(root_);
            lv_image_set_src(r.energy_icons[i], &icon_bolt_off);
            lv_obj_set_pos(r.energy_icons[i], kBoltsX + i * kBoltsStep, y + 1);
        }
    }

    // 大招徽记：左上=对面玩家，右上=自己；三态由服务端决定
    ult_left_ = lv_image_create(root_);
    lv_image_set_src(ult_left_, &ult_idle);
    lv_obj_set_pos(ult_left_, 6, 4);

    ult_right_ = lv_image_create(root_);
    lv_image_set_src(ult_right_, &ult_idle);
    lv_obj_set_pos(ult_right_, 284, 4);

    lv_obj_move_foreground(root_);
    ApplyResources();
    ESP_LOGI(TAG, "HUD created: 12 expressions, two resource rows (opponent/self), dual ult badges");

    // 注意：不再做开机自检演示，开机直接进入正式画面；
    // 需要重放时用串口/MCP 的 hud.demo / self.hud.demo 手动触发。

    // 设备状态 -> 默认表情（休眠/待命）
    xTaskCreate(StateFaceTask, "hud_state", 3072, nullptr, 2, nullptr);
}


bool battle_hud_apply(const battle_hud_state_t *state) {
    HudLock lock;
    if (state == nullptr || root_ == nullptr) {
        return false;
    }
    if (!IsKnownExpression(state->expression)) {
        return false;
    }

    current_battle_ = state->battle;
    if (!current_battle_) {
        // 闲聊/未开局（含结局定格结束）：资源全部收起，表情回到待命，
        // 之后把表情控制权交回平台情绪。
        HideAllResources();
        // 服务端闲聊帧给的是 neutral；真正该显示待命还是休眠由设备收听状态决定，
        // 其余明确表情（如 chatter 里的 kiss/thinking）照常显示。
        ApplyExpression(strcmp(state->expression, "neutral") == 0 ? IdleExpression() : state->expression);
        locked_ = false;
        snprintf(current_mode_, sizeof(current_mode_), "-");
        current_seq_ = state->seq;
        ESP_LOGI(TAG, "apply seq=%d idle: resources hidden, expr=%s, emotion unlocked",
                 current_seq_, current_expression_);
        return true;
    }

    locked_ = true;
    ApplyExpression(state->expression);
    snprintf(current_mode_, sizeof(current_mode_), "%s",
             (state->mode != nullptr && state->mode[0] != '\0') ? state->mode : "pvp");
    current_hp_ = state->max_hp > 0 ? Clamp(state->hp, 0, state->max_hp) : 0;
    current_max_hp_ = state->max_hp > 0 ? state->max_hp : 1;
    current_max_energy_ = Clamp(state->max_energy, 0, 5);
    current_energy_ = Clamp(state->energy, 0, current_max_energy_);
    current_ult_ = Clamp(state->ult, 0, 2);
    current_has_opponent_ = state->has_opponent;
    current_opp_max_hp_ = state->opp_max_hp > 0 ? state->opp_max_hp : 1;
    current_opp_hp_ = state->has_opponent ? Clamp(state->opp_hp, 0, current_opp_max_hp_) : 0;
    current_opp_max_energy_ = Clamp(state->opp_max_energy, 0, 5);
    current_opp_energy_ = state->has_opponent ? Clamp(state->opp_energy, 0, current_opp_max_energy_) : 0;
    current_opp_ult_ = Clamp(state->opp_ult, 0, 2);
    current_seq_ = state->seq;
    current_hold_ms_ = state->hold_ms;
    ApplyResources();
    ScheduleExpressionHold(state->hold_ms);

    if (state->cue != nullptr && state->cue[0] != '\0') {
        battle_hud_play_cue(state->cue);
    }
    ESP_LOGI(TAG, "apply seq=%d expr=%s battle=%d mode=%s self=%d/%d e%d/%d ult%d opp=%s(%d/%d e%d/%d ult%d) cue=%s hold=%dms",
             current_seq_, current_expression_, current_battle_ ? 1 : 0, current_mode_,
             current_hp_, current_max_hp_, current_energy_,
             current_max_energy_, current_ult_, current_has_opponent_ ? "yes" : "no", current_opp_hp_,
             current_opp_max_hp_, current_opp_energy_, current_opp_max_energy_, current_opp_ult_,
             state->cue ? state->cue : "-", state->hold_ms);
    return true;
}

void battle_hud_set_overlay_visible(bool visible) {
    HudLock lock;
    if (root_ == nullptr) {
        return;
    }
    if (visible) {
        lv_obj_remove_flag(root_, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(root_, LV_OBJ_FLAG_HIDDEN);
    }
}

void battle_hud_set_expression(const char *expression, int hold_ms) {
    HudLock lock;
    if (locked_ || root_ == nullptr || expression == nullptr) {
        return;
    }
    if (!IsKnownExpression(expression)) {
        return;
    }
    ApplyExpression(expression);
    ScheduleExpressionHold(hold_ms);
}

void battle_hud_get_state_json(char *out, size_t out_len) {
    if (out == nullptr || out_len == 0) {
        return;
    }
    char opponent[144];
    if (current_has_opponent_) {
        snprintf(opponent, sizeof(opponent),
                 "{\"hp\":%d,\"max_hp\":%d,\"energy\":%d,\"max_energy\":%d,\"ult\":%d}",
                 current_opp_hp_, current_opp_max_hp_, current_opp_energy_,
                 current_opp_max_energy_, current_opp_ult_);
    } else {
        snprintf(opponent, sizeof(opponent), "null");
    }
    snprintf(out, out_len,
             "{\"expression\":\"%s\",\"hp\":%d,\"max_hp\":%d,\"energy\":%d,\"max_energy\":%d,"
             "\"ult\":%d,\"seq\":%d,\"cue\":\"%s\",\"hold_ms\":%d,\"locked\":%s,"
             "\"battle\":%s,\"mode\":\"%s\",\"opponent\":%s}",
             current_expression_, current_hp_, current_max_hp_, current_energy_,
             current_max_energy_, current_ult_, current_seq_, current_cue_, current_hold_ms_,
             locked_ ? "true" : "false", current_battle_ ? "true" : "false", current_mode_,
             opponent);
}

void battle_hud_play_cue(const char *cue) {
    // 待命 / 空 cue 一律静音：静默就是「待命」的听觉标识，也避免回待命时多一段提示音
    if (cue == nullptr || cue[0] == '\0' || strcmp(cue, "neutral") == 0) {
        snprintf(current_cue_, sizeof(current_cue_), "%s", cue ? cue : "");
        ESP_LOGI(TAG, "cue=%s (silent)", cue ? cue : "-");
        return;
    }
    const std::string_view *sound = FindCue(cue);
    if (sound == nullptr) {
        ESP_LOGW(TAG, "unknown cue: %s", cue ? cue : "(null)");
        return;
    }
    snprintf(current_cue_, sizeof(current_cue_), "%s", cue);
    // 走主任务调度，避免在 LVGL/串口任务里直接操作音频解码队列
    Application::GetInstance().Schedule([sound]() {
        Application::GetInstance().PlaySound(*sound);
    });
    ESP_LOGI(TAG, "cue=%s", cue);
}

bool battle_hud_is_locked() {
    return locked_;
}

void battle_hud_unlock() {
    HudLock lock;
    locked_ = false;
    ApplyExpression("neutral");
    ESP_LOGI(TAG, "HUD unlocked");
}

// 截屏：把当前屏幕快照成 RGB565 裸数据，便于本机核对「设备实际渲染成什么样」
bool battle_hud_snapshot(uint8_t **out, size_t *len, int *w, int *h) {
    if (out == nullptr || len == nullptr || w == nullptr || h == nullptr) {
        return false;
    }
    *out = nullptr;
#if !LV_USE_SNAPSHOT
    ESP_LOGW(TAG, "snapshot: LV_USE_SNAPSHOT 未开启");
    return false;
#endif
    HudLock lock;
    lv_display_t *disp = lv_display_get_default();
    if (disp == nullptr) {
        ESP_LOGW(TAG, "snapshot: no display");
        return false;
    }
    int32_t width = lv_display_get_horizontal_resolution(disp);
    int32_t height = lv_display_get_vertical_resolution(disp);
    lv_draw_buf_t *buf = lv_draw_buf_create(width, height, LV_COLOR_FORMAT_RGB565, 0);
    if (buf == nullptr) {
        ESP_LOGW(TAG, "snapshot: draw buf create failed");
        return false;
    }
    if (lv_snapshot_take_to_draw_buf(lv_screen_active(), LV_COLOR_FORMAT_RGB565, buf) != LV_RESULT_OK) {
        lv_draw_buf_destroy(buf);
        ESP_LOGW(TAG, "snapshot: take failed");
        return false;
    }
    size_t row_bytes = static_cast<size_t>(width) * 2;
    size_t bytes = row_bytes * height;
    uint8_t *mem = static_cast<uint8_t *>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM));
    if (mem == nullptr) {
        mem = static_cast<uint8_t *>(heap_caps_malloc(bytes, MALLOC_CAP_DEFAULT));
    }
    if (mem == nullptr) {
        lv_draw_buf_destroy(buf);
        return false;
    }
    uint32_t stride = buf->header.stride != 0 ? buf->header.stride : row_bytes;
    for (int32_t y = 0; y < height; y++) {
        memcpy(mem + static_cast<size_t>(y) * row_bytes,
               static_cast<uint8_t *>(buf->data) + static_cast<size_t>(y) * stride, row_bytes);
    }
    lv_draw_buf_destroy(buf);
    *out = mem;
    *len = bytes;
    *w = width;
    *h = height;
    return true;
}
