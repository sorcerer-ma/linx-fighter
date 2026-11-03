// 战斗 HUD 推送接收（HudLink）
// 服务端在 /device/ws 上主动推帧：连上先给当前画面，之后局面变化才推。
// 本模块只管收帧与去重，渲染仍交给 battle_hud；拉取通道保留作兜底。
#pragma once

#include <stdbool.h>
#include <stddef.h>

/** 启动后台任务：读 NVS 配置，网络就绪后连接并保持长连接 */
void battle_link_start(void);

/**
 * 配置推送地址并落 NVS。成功返回 true，并把实际写入的地址回填到 out。
 * 地址没有 device 参数时自动补上本机 MAC，和服务端设备口径一致。
 */
bool battle_link_configure(const char *url, bool enabled, char *out, size_t out_len);

/** 当前是否启用（NVS 里的开关） */
bool battle_link_enabled(void);
