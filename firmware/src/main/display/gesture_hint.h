/**
 * @file gesture_hint.h
 * 从对话文本里识别明确的身体动作（例如“给我一个飞吻”）。
 *
 * 为什么需要：屏幕表情主要来自平台下发的 emotion，但模型经常把“飞吻”这类
 * 请求回成 happy/neutral，表情就对不上。这里按文本做一层兜底，命中时用
 * 对应表情替换平台情绪，保证“说到做到”。
 */
#ifndef GESTURE_HINT_H
#define GESTURE_HINT_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 识别文本里的动作，返回平台 emotion 名（如 "kissy"），没命中返回 nullptr。
 * 注意：调用方拿到的是静态字符串，不需要释放。
 */
const char *gesture_hint_from_text(const char *text);

#ifdef __cplusplus
}
#endif

#endif  // GESTURE_HINT_H
