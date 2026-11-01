/* 面板级控制：颜色反转开关（不同批次 ST7789 的 INVON/INVOFF 相反） */
#pragma once

#include "esp_lcd_panel_io.h"
#include "esp_lcd_types.h"

void panel_ctrl_set_handle(esp_lcd_panel_handle_t panel);
bool panel_ctrl_invert(bool enable);
