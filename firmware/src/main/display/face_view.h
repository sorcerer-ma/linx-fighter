/**
 * @file face_view.h
 * 矢量表情视图：按设计稿 SVG 转出的图元数据绘制 8 种表情，并驱动待命/进攻/闪避等动画。
 */
#ifndef FACE_VIEW_H
#define FACE_VIEW_H

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 表情编号，顺序与 design 稿一致 */
enum {
    kFaceNeutral = 0,
    kFaceAttack,
    kFaceHurt,
    kFaceGuard,
    kFaceDodge,
    kFaceUltReady,
    kFaceVictory,
    kFaceDefeat,
    /* 日常对话表情（设计稿单独画板） */
    kFaceSurprised,  /* 吃惊：感叹号 */
    kFaceKiss,       /* 飞吻：单眼眨眼 + 爱心 */
    kFaceThinking,   /* 思考：一只圆眼 + 一只半圆眼 + 问号 */
    kFaceSleep,      /* 休眠：闭眼 + Z 字 */
    kFaceCount
};

/** 把 state 里的表情名（neutral/attack/...）转成编号，未知返回 -1 */
int face_expression_from_name(const char *name);

/** 在 parent 上创建整屏表情层 */
void face_view_create(lv_obj_t *parent);

/** 切换表情；animate=true 时按状态做过渡动画 */
void face_view_set(int expression, bool animate);

/** 当前表情编号 */
int face_view_current(void);

/** 主动刷新一帧（一般由内部定时器调用） */
void face_view_tick(void);

#ifdef __cplusplus
}
#endif

#endif /* FACE_VIEW_H */
