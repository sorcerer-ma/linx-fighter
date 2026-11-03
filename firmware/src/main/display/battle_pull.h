// 战斗 HUD 拉取（HudClient）：设备定时向服务端 /device/mcp 拉取权威画面状态
#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 启动拉取任务并注册 self.hud.pull 配置工具；未配置地址时不发请求 */
void battle_pull_start(void);

/** 写入拉取地址并开关（url 为空时沿用已保存值）；成功返回 true 并回填最终地址 */
bool battle_pull_configure(const char *url, bool enabled, char *out, size_t out_len);

/** 应用一帧 HUD JSON（推送通道与拉取通道共用：同一份 seq 去重与渲染） */
bool battle_pull_apply_json(const char *json, size_t len);

#ifdef __cplusplus
}
#endif
