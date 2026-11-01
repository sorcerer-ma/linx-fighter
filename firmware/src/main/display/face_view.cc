/**
 * @file face_view.cc
 * 表情视图：用设计稿 SVG 渲染出的前景位图（RGB565A8 未压缩、按内容裁剪）合成 8 种表情，
 * 并驱动交叉淡入、眨眼、受击抖动、闪避残影、举盾、胜利跳跃等动画。
 *
 * 为什么不在运行时画矢量：LVGL 9.3 的软件矢量渲染在分条带（partial）刷新下
 * 坐标换算出错，整帧会被裁掉；预渲染位图 + LVGL 原生动画既保真又省 CPU。
 */
#include "face_view.h"

#include <cmath>
#include <cstring>

#include "face_assets.h"

namespace {

constexpr int kScreenW = 320;
constexpr int kScreenH = 240;

/* 设计稿底色，顺序与 kFaceCount 一致 */
constexpr uint32_t kBgColor[kFaceCount] = {
    0x1A4038, /* neutral  */
    0x1A4038, /* attack   */
    0x663E31, /* hurt     */
    0x273C4D, /* guard    */
    0x1A4038, /* dodge    */
    0x854725, /* ultready */
    0x305426, /* victory  */
    0x333C4B, /* defeat   */
    /* 这四张脸把底色烘焙进了位图（省掉 3 倍透明位图空间），
       下面的值取位图经 RGB565 量化后的底色，保证整屏看不出版块边界 */
    0x1A3E33, /* surprised */
    0x1A3E33, /* kiss      */
    0x1A3E33, /* thinking  */
    0x1A3E33, /* sleep     */
};

const char *const kExpressionNames[kFaceCount] = {
    "neutral", "attack", "hurt", "guard", "dodge", "ultready", "victory", "defeat",
    "surprised", "kiss", "thinking", "sleep",
};

const lv_image_dsc_t *const kFaceImage[kFaceCount] = {
    &face_neutral, &face_attack, &face_hurt, &face_guard,
    &face_dodge, &face_ultready, &face_victory, &face_defeat,
    &face_surprised, &face_kiss, &face_thinking, &face_sleep,
};

/* 前景图按内容裁剪过，摆放时要把裁剪左上角偏移加回来 */
struct FaceAssetPos {
    const lv_image_dsc_t *img;
    int x;
    int y;
};

const FaceAssetPos kAssetPos[] = {
    {&face_neutral, FACE_NEUTRAL_X, FACE_NEUTRAL_Y},
    {&face_neutral_blink, FACE_NEUTRAL_BLINK_X, FACE_NEUTRAL_BLINK_Y},
    {&face_attack_flat, FACE_ATTACK_FLAT_X, FACE_ATTACK_FLAT_Y},
    {&face_attack, FACE_ATTACK_X, FACE_ATTACK_Y},
    {&face_hurt, FACE_HURT_X, FACE_HURT_Y},
    {&face_guard, FACE_GUARD_X, FACE_GUARD_Y},
    {&face_dodge, FACE_DODGE_X, FACE_DODGE_Y},
    {&face_ultready, FACE_ULTREADY_X, FACE_ULTREADY_Y},
    {&face_victory, FACE_VICTORY_X, FACE_VICTORY_Y},
    {&face_defeat, FACE_DEFEAT_X, FACE_DEFEAT_Y},
    {&face_surprised, FACE_SURPRISED_X, FACE_SURPRISED_Y},
    {&face_kiss, FACE_KISS_X, FACE_KISS_Y},
    {&face_thinking, FACE_THINKING_X, FACE_THINKING_Y},
    {&face_sleep, FACE_SLEEP_X, FACE_SLEEP_Y},
};

FaceAssetPos PosOf(const lv_image_dsc_t *src)
{
    for (const auto &entry : kAssetPos) {
        if (entry.img == src) {
            return entry;
        }
    }
    return {nullptr, 0, 0};
}

constexpr uint32_t kTickMs = 33;          /* 约 30fps */
constexpr uint32_t kBgFadeMs = 300;       /* 底色渐变 */
constexpr uint32_t kFadeMs = 300;         /* 常规表情交叉淡入 */
constexpr uint32_t kAttackFlatMs = 140;   /* 进攻：平眉浮现 */
constexpr uint32_t kAttackSlantMs = 380;  /* 进攻：眉变斜、嘴变直 */
constexpr uint32_t kBlinkCloseMs = 120;   /* 眨眼闭眼时长 */
constexpr uint32_t kBlinkPeriodMs = 3200; /* 眨眼间隔 */
constexpr uint32_t kGhostHoldMs = 160;    /* 残影保持时长 */
constexpr uint32_t kGhostFadeMs = 260;    /* 残影淡出时长 */
constexpr uint32_t kSwayMs = 900;         /* 闪避摆动衰减时长 */

enum FxKind {
    kFxNone = 0,
    kFxHurt = 1,     /* 受击抖动 */
    kFxVictory = 2,  /* 胜利上跳 */
    kFxDefeat = 3,   /* 失败下沉 */
    kFxGuard = 4,    /* 举盾升起 */
    kFxDodge = 5,    /* 闪避滑入 */
};

struct FadeAnim {
    bool active = false;
    uint32_t start = 0;
    uint32_t dur = 0;
    int expr = kFaceNeutral;       /* 淡入完成后上层对应的表情 */
    int after_expr = -1;           /* 紧接的第二段淡入目标 */
};

struct FxAnim {
    FxKind kind = kFxNone;
    uint32_t start = 0;
    uint32_t dur = 0;
};

lv_obj_t *g_root = nullptr;
lv_obj_t *g_bg = nullptr;
lv_obj_t *g_img[2] = {nullptr, nullptr};
lv_obj_t *g_ghost[2] = {nullptr, nullptr};
/* 表情特效层：吃惊的感叹号、飞吻的爱心、思考的问号、休眠的三枚 Z 字 */
lv_obj_t *g_fx_img[3] = {nullptr, nullptr, nullptr};
uint32_t g_fx_start = 0;

int g_top = 0;              /* 上层图片下标 */
int g_expr = kFaceNeutral;  /* 目标表情 */
int g_shown = kFaceNeutral; /* 上层图片对应的表情 */

FadeAnim g_fade;
FxAnim g_fx;

float g_offset_x = 0.0f;
float g_offset_y = 0.0f;

bool g_ghosts_on = false;
float g_ghost_opa = 0.0f;
uint32_t g_ghost_start = 0;

bool g_blinking = false;
uint32_t g_blink_start = 0;
uint32_t g_next_blink = 0;

uint32_t g_bg_from = 0x1A4038; /* 0xRRGGBB，自己插值，避免 16 位色深下分量精度问题 */
uint32_t g_bg_to = 0x1A4038;
uint32_t g_bg_cur = 0x1A4038;
uint32_t g_bg_start = 0;

inline float EaseOut(float t)
{
    return 1.0f - (1.0f - t) * (1.0f - t);
}

inline float Clamp01(float v)
{
    return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
}

inline float Progress(uint32_t now, uint32_t start, uint32_t dur)
{
    if (dur == 0) {
        return 1.0f;
    }
    const uint32_t elapsed = now - start;
    return elapsed >= dur ? 1.0f : static_cast<float>(elapsed) / static_cast<float>(dur);
}

const lv_image_dsc_t *FaceSource(int expression)
{
    if (expression < 0 || expression >= kFaceCount) {
        return &face_neutral;
    }
    return kFaceImage[expression];
}

/* ---------- 表情特效：感叹号 / 爱心 / 问号 / Z 字 ---------- */
struct FxPlacement {
    const lv_image_dsc_t *src;
    int x;
    int y;
};

/* 每个表情最多 3 片特效，返回片数并填写源图与基准位置 */
int FxLayout(int expression, FxPlacement out[3])
{
    switch (expression) {
        case kFaceSurprised:
            out[0] = {&fx_bang, FX_BANG_X, FX_BANG_Y};
            return 1;
        case kFaceKiss:
            out[0] = {&fx_heart, FX_HEART_X, FX_HEART_Y};
            return 1;
        case kFaceThinking:
            out[0] = {&fx_question, FX_QUESTION_X, FX_QUESTION_Y};
            return 1;
        case kFaceSleep:
            out[0] = {&fx_z1, FX_Z1_X, FX_Z1_Y};
            out[1] = {&fx_z2, FX_Z2_X, FX_Z2_Y};
            out[2] = {&fx_z3, FX_Z3_X, FX_Z3_Y};
            return 3;
        default:
            return 0;
    }
}

void HideAllFx(void)
{
    for (auto *img : g_fx_img) {
        if (img != nullptr) {
            lv_obj_add_flag(img, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

void ShowFx(int index, const lv_image_dsc_t *src, int x, int y, int opa)
{
    lv_obj_t *img = g_fx_img[index];
    if (img == nullptr) {
        return;
    }
    if (lv_image_get_src(img) != src) {
        lv_image_set_src(img, src);
    }
    lv_obj_remove_flag(img, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_pos(img, x, y);
    lv_image_set_scale(img, 256);
    const int clamped = opa < 0 ? 0 : (opa > 255 ? 255 : opa);
    lv_obj_set_style_image_opa(img, static_cast<lv_opa_t>(clamped), 0);
}

/* 特效动画：感叹号弹一下、爱心向上飘、问号轻晃、Z 字错峰上浮 */
void UpdateFx(uint32_t now)
{
    FxPlacement layout[3] = {};
    const int count = FxLayout(g_expr, layout);
    if (count == 0) {
        HideAllFx();
        return;
    }
    // 先全部隐藏，再只显示当前表情需要的特效；否则从休眠切到别的表情时，
    // 上一组的 Z 字会残留在右上角。
    HideAllFx();
    const uint32_t t = now - g_fx_start;
    switch (g_expr) {
        case kFaceSurprised: {
            const float p = Clamp01(static_cast<float>(t) / 260.0f);
            const float pop = 1.0f + 0.32f * (1.0f - EaseOut(p));
            const int bob = static_cast<int>(std::sin(static_cast<float>(t) / 240.0f) * 2.0f);
            ShowFx(0, layout[0].src, layout[0].x, layout[0].y + bob, 255);
            lv_image_set_scale(g_fx_img[0], static_cast<uint32_t>(256.0f * pop));
            break;
        }
        case kFaceKiss: {
            const float p = static_cast<float>(t % 1500) / 1500.0f;
            const int rise = static_cast<int>(26.0f * EaseOut(p));
            const int opa = p < 0.18f ? static_cast<int>(255.0f * (p / 0.18f))
                                      : static_cast<int>(255.0f * (1.0f - (p - 0.18f) / 0.82f));
            ShowFx(0, layout[0].src, layout[0].x, layout[0].y - rise, opa);
            break;
        }
        case kFaceThinking: {
            const float p = static_cast<float>(t % 1800) / 1800.0f;
            const int bob = static_cast<int>(std::sin(p * 6.2831853f) * 4.0f);
            ShowFx(0, layout[0].src, layout[0].x, layout[0].y + bob, 235);
            break;
        }
        case kFaceSleep: {
            constexpr uint32_t kCycle = 2400;
            for (int i = 0; i < 3; i++) {
                const uint32_t local = (t + static_cast<uint32_t>(i) * 700) % kCycle;
                const float p = static_cast<float>(local) / static_cast<float>(kCycle);
                const int rise = static_cast<int>(20.0f * p);
                const int opa = p < 0.22f ? static_cast<int>(255.0f * (p / 0.22f))
                                          : static_cast<int>(255.0f * (1.0f - (p - 0.22f) / 0.78f));
                ShowFx(i, layout[i].src, layout[i].x, layout[i].y - rise, opa);
            }
            break;
        }
        default:
            HideAllFx();
            break;
    }
}

/* 把位移与残影透明度同步到所有图元（每张图各自带裁剪偏移） */
void ApplyTransform(void)
{
    for (auto *img : g_img) {
        if (img == nullptr) {
            continue;
        }
        const FaceAssetPos pos = PosOf(static_cast<const lv_image_dsc_t *>(lv_image_get_src(img)));
        lv_obj_set_pos(img, static_cast<int32_t>(pos.x + g_offset_x), static_cast<int32_t>(pos.y + g_offset_y));
    }
    for (int i = 0; i < 2; i++) {
        if (g_ghost[i] == nullptr) {
            continue;
        }
        const float dx = (i == 0 ? 28.0f : 56.0f) + g_offset_x;
        lv_obj_set_pos(g_ghost[i], static_cast<int32_t>(FACE_DODGE_X + dx),
                       static_cast<int32_t>(FACE_DODGE_Y + g_offset_y));
        const float weight = (i == 0 ? 1.0f : 0.62f);
        lv_obj_set_style_image_opa(g_ghost[i],
                                   static_cast<lv_opa_t>(Clamp01(g_ghost_opa * weight) * 255.0f), 0);
    }
}

/* 直接换上层图片，不做淡入 */
void ShowImmediate(int expression)
{
    g_fade.active = false;
    g_top = g_top;
    lv_image_set_src(g_img[g_top], FaceSource(expression));
    lv_obj_remove_flag(g_img[g_top], LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_opa(g_img[g_top], LV_OPA_COVER, 0);
    lv_obj_add_flag(g_img[1 - g_top], LV_OBJ_FLAG_HIDDEN);
    g_shown = expression;
    g_blinking = false;
    g_fx_start = lv_tick_get();
    ApplyTransform();
    if (g_root != nullptr) {
        lv_obj_invalidate(g_root);
    }
}

/* 交叉淡入：新画面画在另一层上，从透明渐显；完成后翻层 */
void FadeTo(const lv_image_dsc_t *src, int expr, uint32_t dur, int after_expr)
{
    /* 上一段淡入未完成就先把它定格，避免两层都在半透明 */
    if (g_fade.active) {
        g_fade.active = false;
        g_top = 1 - g_top;
        lv_obj_add_flag(g_img[1 - g_top], LV_OBJ_FLAG_HIDDEN);
        g_shown = g_fade.expr;
    }
    const int back = 1 - g_top;
    lv_image_set_src(g_img[back], src);
    lv_obj_remove_flag(g_img[back], LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_opa(g_img[back], LV_OPA_TRANSP, 0);
    g_fade.active = true;
    g_fade.start = lv_tick_get();
    g_fade.dur = dur;
    g_fade.expr = expr;
    g_fade.after_expr = after_expr;
    ApplyTransform();
}

/* 底色渐变起点取当前实际颜色，渐变中途再切换也不会跳变 */
void StartBgFade(int expression)
{
    g_bg_from = g_bg_cur;
    g_bg_to = kBgColor[expression];
    g_bg_start = lv_tick_get();
}

void SetGhosts(bool on)
{
    g_ghosts_on = on;
    g_ghost_opa = 0.0f;
    g_ghost_start = lv_tick_get();
    for (auto *ghost : g_ghost) {
        if (ghost == nullptr) {
            continue;
        }
        if (on && &ghost != &g_ghost[1]) {
            lv_image_set_src(ghost, &face_dodge);
            lv_obj_remove_flag(ghost, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(ghost, LV_OBJ_FLAG_HIDDEN);
        }
    }
    ApplyTransform();
}

void TickCallback(lv_timer_t *)
{
    if (g_root == nullptr) {
        return;
    }
    const uint32_t now = lv_tick_get();

    /* 底色渐变 */
    {
        const float p = Progress(now, g_bg_start, kBgFadeMs);
        const uint32_t from = g_bg_from;
        const uint32_t to = g_bg_to;
        const int32_t r0 = (from >> 16) & 0xFF, g0 = (from >> 8) & 0xFF, b0 = from & 0xFF;
        const int32_t r1 = (to >> 16) & 0xFF, g1 = (to >> 8) & 0xFF, b1 = to & 0xFF;
        const int32_t r = r0 + (r1 - r0) * p;
        const int32_t g = g0 + (g1 - g0) * p;
        const int32_t b = b0 + (b1 - b0) * p;
        g_bg_cur = (static_cast<uint32_t>(r) << 16) | (static_cast<uint32_t>(g) << 8) | static_cast<uint32_t>(b);
        lv_obj_set_style_bg_color(g_bg, lv_color_hex(g_bg_cur), LV_PART_MAIN);
    }

    /* 交叉淡入 */
    if (g_fade.active) {
        const float p = Progress(now, g_fade.start, g_fade.dur);
        lv_obj_set_style_opa(g_img[1 - g_top], static_cast<lv_opa_t>(Clamp01(p) * 255.0f), 0);
        if (p >= 1.0f) {
            g_fade.active = false;
            g_top = 1 - g_top;
            lv_obj_add_flag(g_img[1 - g_top], LV_OBJ_FLAG_HIDDEN);
            g_shown = g_fade.expr;
            const int after = g_fade.after_expr;
            g_fade.after_expr = -1;
            /* 进攻是两段式：平眉定格后再过渡到斜眉+平嘴。这里不能用 g_shown 比较，
               因为第一段的目标表情已经是 attack，比较会把它当成已经到达而跳过第二段。 */
            if (after >= 0) {
                FadeTo(FaceSource(after), after, kAttackSlantMs, -1);
            }
        }
    }

    /* 位移动画 */
    if (g_fx.kind != kFxNone) {
        const float p = Progress(now, g_fx.start, g_fx.dur);
        switch (g_fx.kind) {
            case kFxHurt:
                g_offset_x = std::sin(p * 3.14159f * 6.0f) * 7.0f * (1.0f - p);
                break;
            case kFxVictory:
                g_offset_y = -std::fabs(std::sin(p * 3.14159f * 2.0f)) * 9.0f * (1.0f - p * 0.5f);
                break;
            case kFxDefeat:
                g_offset_y = 2.5f * EaseOut(p);
                break;
            case kFxGuard:
                g_offset_y = 40.0f * (1.0f - EaseOut(p));
                break;
            case kFxDodge:
                /* 从右侧微微平移进来，落位后交给下方的来回摆动 */
                g_offset_x = 40.0f * (1.0f - EaseOut(p));
                break;
            default:
                break;
        }
        if (p >= 1.0f) {
            if (g_fx.kind == kFxDefeat) {
                g_offset_y = 2.5f;
            } else {
                g_offset_x = 0.0f;
                g_offset_y = 0.0f;
            }
            g_fx.kind = kFxNone;
        }
    }

    /* 表情特效（感叹号/爱心/问号/Z 字） */
    UpdateFx(now);

    /* 闪避：残影渐显、来回摆动，随后缓慢淡出（用户要求残影不要消失太快） */
    if (g_ghosts_on) {
        const uint32_t life = now - g_ghost_start;
        const float rise = Clamp01(static_cast<float>(life) / 220.0f);
        const float fade = life <= kGhostHoldMs ? 1.0f
                          : Clamp01(1.0f - static_cast<float>(life - kGhostHoldMs) / kGhostFadeMs);
        g_ghost_opa = 0.38f * rise * fade;
        if (g_expr == kFaceDodge) {
            if (g_fx.kind == kFxNone) {
                /* 摆幅随生命期衰减，最后静止 */
                const float decay = Clamp01(1.0f - static_cast<float>(life) / static_cast<float>(kSwayMs));
                g_offset_x = std::sin(static_cast<float>(now) / 70.0f) * 11.0f * decay;
            }
        }
        if (fade <= 0.0f) {
            SetGhosts(false);
            g_offset_x = 0.0f;
        }
    }

    /* 大招就绪：整脸轻微呼吸，衬托火焰 */
    if (g_expr == kFaceUltReady && !g_fade.active) {
        const float pulse = 0.94f + 0.06f * std::sin(static_cast<float>(now) / 700.0f);
        lv_obj_set_style_opa(g_img[g_top], static_cast<lv_opa_t>(pulse * 255.0f), 0);
    } else if (!g_fade.active) {
        lv_obj_set_style_opa(g_img[g_top], LV_OPA_COVER, 0);
    }

    /* 待命眨眼 / 其余表情保持当前画面 */
    if (g_expr == kFaceNeutral && g_shown == kFaceNeutral && !g_fade.active && !g_blinking &&
        now >= g_next_blink) {
        g_blinking = true;
        g_blink_start = now;
        lv_image_set_src(g_img[g_top], &face_neutral_blink);
        lv_obj_invalidate(g_root);
    } else if (g_blinking && now - g_blink_start >= kBlinkCloseMs) {
        g_blinking = false;
        g_next_blink = now + kBlinkPeriodMs;
        lv_image_set_src(g_img[g_top], FaceSource(g_shown));
        lv_obj_invalidate(g_root);
    }

    ApplyTransform();
}

} // namespace

int face_expression_from_name(const char *name)
{
    if (name == nullptr) {
        return -1;
    }
    for (int i = 0; i < kFaceCount; i++) {
        if (strcmp(name, kExpressionNames[i]) == 0) {
            return i;
        }
    }
    return -1;
}

void face_view_create(lv_obj_t *parent)
{
    if (g_root != nullptr || parent == nullptr) {
        return;
    }
    g_root = lv_obj_create(parent);
    lv_obj_remove_style_all(g_root);
    lv_obj_set_size(g_root, kScreenW, kScreenH);
    lv_obj_set_pos(g_root, 0, 0);
    lv_obj_remove_flag(g_root, LV_OBJ_FLAG_SCROLLABLE);

    g_bg = lv_obj_create(g_root);
    lv_obj_remove_style_all(g_bg);
    lv_obj_set_size(g_bg, kScreenW, kScreenH);
    lv_obj_set_pos(g_bg, 0, 0);
    lv_obj_set_style_bg_opa(g_bg, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(g_bg, lv_color_hex(kBgColor[kFaceNeutral]), LV_PART_MAIN);

    for (auto &ghost : g_ghost) {
        ghost = lv_image_create(g_root);
        lv_image_set_src(ghost, &face_dodge);
        lv_obj_set_pos(ghost, 0, 0);
        lv_obj_add_flag(ghost, LV_OBJ_FLAG_HIDDEN);
        /* 用图片透明度而不是对象透明度：对象 opa=0 会让整块图元直接不可见 */
        lv_obj_set_style_image_opa(ghost, LV_OPA_TRANSP, 0);
    }
    for (auto &img : g_img) {
        img = lv_image_create(g_root);
        lv_image_set_src(img, &face_neutral);
        lv_obj_set_pos(img, 0, 0);
        lv_obj_add_flag(img, LV_OBJ_FLAG_HIDDEN);
    }
    for (auto &ghost : g_ghost) {
        ghost = lv_image_create(g_root);
        lv_image_set_src(ghost, &face_dodge);
        lv_obj_set_pos(ghost, 0, 0);
        lv_obj_add_flag(ghost, LV_OBJ_FLAG_HIDDEN);
        /* 用图片透明度而不是对象透明度：对象 opa=0 会让整块图元直接不可见 */
        lv_obj_set_style_image_opa(ghost, LV_OPA_TRANSP, 0);
    }

    for (auto &img : g_fx_img) {
        img = lv_image_create(g_root);
        lv_image_set_src(img, &fx_bang);
        lv_obj_add_flag(img, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_image_opa(img, LV_OPA_COVER, 0);
    }

    g_top = 0;
    ShowImmediate(kFaceNeutral);
    g_bg_from = kBgColor[kFaceNeutral];
    g_bg_to = g_bg_from;
    g_bg_cur = g_bg_from;
    g_next_blink = lv_tick_get() + kBlinkPeriodMs;
    lv_timer_create(TickCallback, kTickMs, nullptr);
}

void face_view_set(int expression, bool animate)
{
    if (g_root == nullptr || expression < 0 || expression >= kFaceCount) {
        return;
    }
    if (expression == g_expr && !g_fade.active && g_fx.kind == kFxNone) {
        return;
    }
    const int prev = g_shown;
    g_expr = expression;
    SetGhosts(false);
    StartBgFade(expression);

    if (!animate) {
        ShowImmediate(expression);
        g_offset_x = 0.0f;
        g_offset_y = 0.0f;
        g_fx.kind = kFxNone;
        ApplyTransform();
        return;
    }

    switch (expression) {
        case kFaceAttack:
            if (prev == kFaceNeutral) {
                /* 先浮现平直眉毛，再让眉毛变斜、嘴变直 */
                FadeTo(&face_attack_flat, kFaceAttack, kAttackFlatMs, kFaceAttack);
            } else {
                FadeTo(&face_attack, kFaceAttack, kFadeMs, -1);
            }
            break;
        case kFaceHurt:
            ShowImmediate(kFaceHurt);
            g_fx.kind = kFxHurt;
            g_fx.start = lv_tick_get();
            g_fx.dur = 320;
            break;
        case kFaceGuard:
            FadeTo(&face_guard, kFaceGuard, 200, -1);
            g_fx.kind = kFxGuard;
            g_fx.start = lv_tick_get();
            g_fx.dur = 240;
            break;
        case kFaceDodge:
            SetGhosts(true);
            FadeTo(&face_dodge, kFaceDodge, 160, -1);
            g_fx.kind = kFxDodge;
            g_fx.start = lv_tick_get();
            g_fx.dur = 280;
            break;
        case kFaceVictory:
            FadeTo(&face_victory, kFaceVictory, 200, -1);
            g_fx.kind = kFxVictory;
            g_fx.start = lv_tick_get();
            g_fx.dur = 1500;
            break;
        case kFaceDefeat:
            FadeTo(&face_defeat, kFaceDefeat, kFadeMs, -1);
            g_fx.kind = kFxDefeat;
            g_fx.start = lv_tick_get();
            g_fx.dur = 700;
            break;
        case kFaceSurprised:
        case kFaceKiss:
        case kFaceThinking:
        case kFaceSleep:
            /* 日常对话表情：短促淡入，特效由 UpdateFx 循环驱动 */
            FadeTo(FaceSource(expression), expression, 220, -1);
            g_fx_start = lv_tick_get();
            break;
        default:
            FadeTo(FaceSource(expression), expression, kFadeMs, -1);
            break;
    }
    ApplyTransform();
}

int face_view_current(void)
{
    return g_expr;
}

void face_view_tick(void)
{
    TickCallback(nullptr);
}
