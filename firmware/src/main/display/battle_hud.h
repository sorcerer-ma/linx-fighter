// 战斗 HUD：8 表情 + 生命条 + 5 闪电能量 + 大招徽记三态
// 状态由服务端权威派生后通过 MCP / 串口命令下发，设备只负责渲染与提示音
#pragma once

#include <lvgl.h>

#include "display.h"
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 一次 HUD 展示快照（字段与外观一一对应，不含文字） */
typedef struct {
    const char *expression;  /* 表情名：neutral/attack/hurt/guard/dodge/ultready/victory/defeat */
    bool battle;             /* 是否在战斗中；false 时只画表情，不画资源行与徽记 */
    const char *mode;        /* 对局形态："pvp" 上排对手、下排自己；"solo" 上排自己；NULL 按 pvp */
    int hp;
    int max_hp;
    int energy;
    int max_energy;
    int ult;                 /* 0=未就绪 1=可释放 2=本局已用 */
    int seq;                 /* 状态序号，用于去重与补发判断 */
    const char *cue;         /* 音效名，可为 NULL */
    int hold_ms;             /* 表情保持时长（毫秒），0 表示常驻 */

    /* 对面玩家（两块屏相对摆放：本设备显示「对手在上一行、自己在下一行」）。
       没有对手（单人等待加入）时 has_opponent=false，上排整行隐藏。 */
    bool has_opponent;
    int opp_hp;
    int opp_max_hp;
    int opp_energy;
    int opp_max_energy;
    int opp_ult;             /* 0=未就绪 1=可释放 2=本局已用 */
} battle_hud_state_t;

/** 创建 HUD 层（在 LcdDisplay::SetupUI 末尾调用，沿用同一块屏幕） */
// 传入 display：板级构造函数里 Board::GetInstance() 尚未就绪，不能反查单例
void battle_hud_create(Display* display);

/** 应用一次状态；返回 false 表示入参非法 */
bool battle_hud_apply(const battle_hud_state_t *state);

/** 设置表情（platform 情绪或临时表情用；HUD 接管后忽略） */
void battle_hud_set_expression(const char *expression, int hold_ms);

// 战斗 HUD 图层显隐：系统界面（配网/激活）需要整屏显示原始提示时隐藏
void battle_hud_set_overlay_visible(bool visible);

/** 当前状态导出为 JSON（供 hud.get_state 与 MCP 工具返回） */
void battle_hud_get_state_json(char *out, size_t out_len);

/** 播报音效名对应的内置 ogg */
void battle_hud_play_cue(const char *cue);

/** 是否已由战斗状态接管显示（接管后忽略平台情绪） */
bool battle_hud_is_locked(void);

/** 解除接管：回到待命表情，恢复平台情绪可用 */
void battle_hud_unlock(void);

/** 启动串口命令通道（USB Serial/JTAG，JSON-RPC 风格） */
// 截取当前屏幕为 RGB565 位图；成功时 *out 需调用方 heap_caps_free 释放
bool battle_hud_snapshot(uint8_t **out, size_t *len, int *w, int *h);
void battle_ctl_start(void);
// 异步启动 8 表情/音效演示（开机自检与 hud.demo 共用）
void battle_demo_start(void);
// 注册 self.hud.* 设备 MCP 工具（由 battle_ctl_start 调用）
void battle_mcp_register(void);

#ifdef __cplusplus
}
#endif
