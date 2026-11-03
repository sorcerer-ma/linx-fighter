#pragma once

#include <lvgl.h>

#ifdef __cplusplus
extern "C" {
#endif

// 战斗 HUD 位图资源：只保留图标，表情改由矢量 face_view 绘制
extern const lv_image_dsc_t icon_heart;
extern const lv_image_dsc_t icon_bolt_on;
extern const lv_image_dsc_t icon_bolt_off;
extern const lv_image_dsc_t ult_idle;
extern const lv_image_dsc_t ult_ready;
extern const lv_image_dsc_t ult_used;

#ifdef __cplusplus
}
#endif
