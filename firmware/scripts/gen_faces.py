# 生成 8 种战斗表情位图（240x170），风格参考设计图：深色面板 + 浅绿发光眼/嘴
from PIL import Image, ImageDraw, ImageFilter
import math

W,H = 240,170
EYE = (198,238,186)      # 浅绿发光
DIM = (150,200,150)      # 暗一档
BG = {
 'neutral': (23,52,42),
 'attack':  (23,52,42),
 'hurt':    (58,33,24),
 'guard':   (27,42,58),
 'dodge':   (23,52,42),
 'ultready':(66,36,14),
 'victory': (29,59,35),
 'defeat':  (26,34,51),
}

def panel(d, color):
    d.rounded_rectangle([4,4,W-5,H-5], radius=18, fill=color)

def glow(img, draw_fn, blur=6, alpha=140):
    layer = Image.new('RGBA', img.size, (0,0,0,0))
    d = ImageDraw.Draw(layer)
    draw_fn(d, (255,255,255,alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(layer)

def eyes_open(d, color, cy=78, rx=15, ry=19, dx=32):
    for cx in (W//2-dx, W//2+dx):
        d.ellipse([cx-rx, cy-ry, cx+rx, cy+ry], fill=color)
        # 高光
        d.ellipse([cx-rx+5, cy-ry+5, cx-rx+11, cy-ry+11], fill=(255,255,255,200))

def brows(d, color, angry=True, cy=44):
    if angry:
        d.line([W//2-46,cy-6, W//2-22,cy+2], fill=color, width=7)
        d.line([W//2+22,cy+2, W//2+46,cy-6], fill=color, width=7)
    else:
        d.line([W//2-46,cy+2, W//2-22,cy-4], fill=color, width=6)
        d.line([W//2+22,cy-4, W//2+46,cy+2], fill=color, width=6)

def mouth_smile(d, color, w=34, cy=124, up=True, ry=16):
    box=[W//2-w, cy-ry, W//2+w, cy+ry]
    if up: d.arc(box, 10, 170, fill=color, width=7)
    else:  d.arc(box, 190, 350, fill=color, width=7)

def face(kind):
    img = Image.new('RGBA',(W,H),(0,0,0,0))
    d = ImageDraw.Draw(img)
    panel(d, BG[kind])
    # 柔光层：眼睛和嘴的模糊辉光
    if kind not in ('hurt',):
        glow(img, lambda dd,c: (eyes_open(dd,c), mouth_smile(dd,c)) and None, blur=10, alpha=90)
    d = ImageDraw.Draw(img)

    if kind == 'neutral':
        eyes_open(d, EYE); mouth_smile(d, EYE)
    elif kind == 'attack':
        brows(d, EYE, angry=True); eyes_open(d, EYE, ry=17)
        d.line([W//2-26,126, W//2+26,126], fill=EYE, width=7)
    elif kind == 'hurt':
        # X 眼 + 小圆嘴 + 侧边闪电
        for cx in (W//2-32, W//2+32):
            d.line([cx-14,64,cx+14,92], fill=EYE, width=8)
            d.line([cx-14,92,cx+14,64], fill=EYE, width=8)
        d.ellipse([W//2-13,112,W//2+13,138], outline=EYE, width=7)
        for sx,dir in ((24,1),(W-24,-1)):
            pts=[(sx,58),(sx+dir*12,74),(sx+dir*2,76),(sx+dir*12,96)]
            d.line(pts, fill=(240,205,90), width=6)
    elif kind == 'guard':
        # 举盾遮住下半脸
        shield=[(W//2,34),(W//2+58,52),(W//2+50,118),(W//2,146),(W//2-50,118),(W//2-58,52)]
        d.polygon(shield, fill=(196,216,224,235))
        d.polygon(shield, outline=(236,246,250,255), width=5)
        d.line([W//2,52,W//2,138], fill=(120,150,160,180), width=4)
        d.line([W//2-40,78,W//2+40,78], fill=(120,150,160,180), width=4)
    elif kind == 'dodge':
        # 三张虚影：两侧淡、中间实；中间脸略微右移
        for off,alpha in ((-52,60),(-26,110),(0,255)):
            layer=Image.new('RGBA',(W,H),(0,0,0,0)); ld=ImageDraw.Draw(layer)
            cxp=W//2+off
            for cx in (cxp-32, cxp+32):
                ld.ellipse([cx-13,60,cx+13,94], fill=(*EYE,alpha))
            ld.arc([cxp-34,102,cxp+34,140], 15, 165, fill=(*EYE,alpha), width=7)
            img.alpha_composite(layer)
        d=ImageDraw.Draw(img)
    elif kind == 'ultready':
        # 火焰背景：多层尖角
        for i,(col,scale) in enumerate([((120,52,18,200),1.0),((176,74,20,220),0.75)]):
            for k in range(7):
                bx = 40 + k*28
                hgt = int((70+ (k%3)*26)*scale)
                d.polygon([(bx,168),(bx+13,168-hgt),(bx+26,168)], fill=col)
        brows(d, (255,214,150), angry=True)
        eyes_open(d, (255,244,214), dx=32, ry=17)
        d.line([W//2-24,124,W//2+24,120], fill=(255,244,214), width=7)
    elif kind == 'victory':
        # 弯眼 + 张嘴
        d.arc([W//2-60,52,W//2-8,104], 200, 340, fill=EYE, width=8)
        d.arc([W//2+8,52,W//2+60,104], 200, 340, fill=EYE, width=8)
        d.ellipse([W//2-26,104,W//2+26,150], fill=(10,26,20), outline=EYE, width=7)
    elif kind == 'defeat':
        brows(d, (150,190,170), angry=False, cy=46)
        eyes_open(d, (150,190,170), ry=16, dx=32)
        # 下垂嘴
        d.arc([W//2-34,118,W//2+34,150], 200, 340, fill=(150,190,170), width=7)
    return img

for k in ['neutral','attack','hurt','guard','dodge','ultready','victory','defeat']:
    im=face(k); im.save(f'/tmp/hud/assets/{k}.png')
print('ok')
