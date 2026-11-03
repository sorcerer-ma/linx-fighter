#include "panel_ctrl.h"

#include "esp_lcd_panel_ops.h"
#include "esp_log.h"

namespace {
esp_lcd_panel_handle_t g_panel = nullptr;
} // namespace

void panel_ctrl_set_handle(esp_lcd_panel_handle_t panel)
{
    g_panel = panel;
}

bool panel_ctrl_invert(bool enable)
{
    if (g_panel == nullptr) {
        return false;
    }
    ESP_LOGI("PanelCtrl", "invert colors: %d", (int)enable);
    esp_lcd_panel_invert_color(g_panel, enable);
    return true;
}
