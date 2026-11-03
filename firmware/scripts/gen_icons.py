# 生成 HUD 图标：心形、闪电（实心/空心）、大招徽记三态
from PIL import Image, ImageDraw
OUT='/tmp/hud/assets'

def heart(size=16):
    S=size*4
    im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    c=(232,120,108,255)
    d.ellipse([S*0.08,S*0.10,S*0.50,S*0.52],fill=c)
    d.ellipse([S*0.50,S*0.10,S*0.92,S*0.52],fill=c)
    d.polygon([(S*0.06,S*0.42),(S*0.94,S*0.42),(S*0.5,S*0.94)],fill=c)
    return im.resize((size,size),Image.LANCZOS)

def bolt(size=14, filled=True):
    S=size*4
    im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    pts=[(S*0.60,S*0.02),(S*0.18,S*0.56),(S*0.44,S*0.56),(S*0.34,S*0.98),(S*0.84,S*0.40),(S*0.54,S*0.40)]
    if filled:
        d.polygon(pts,fill=(241,216,157,255))
    else:
        d.polygon(pts,outline=(120,134,120,255),width=max(2,S//12))
    return im.resize((size,size),Image.LANCZOS)

def ult(kind, size=30):
    S=size*4
    im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    c=(255,230,161,255) if kind!='used' else (192,200,184,255)
    R=S*0.34
    cx=cy=S/2
    # 外弧
    if kind=='idle':
        d.arc([cx-R*1.5,cy-R*1.5,cx+R*1.5,cy+R*1.5],120,380,fill=c,width=max(2,S//16))
        d.ellipse([cx-R*0.45,cy-R*0.45,cx+R*0.45,cy+R*0.45],outline=c,width=max(2,S//16))
    elif kind=='ready':
        d.arc([cx-R*1.5,cy-R*1.5,cx+R*1.5,cy+R*1.5],0,360,fill=c,width=max(2,S//16))
        d.ellipse([cx-R*0.55,cy-R*0.55,cx+R*0.55,cy+R*0.55],fill=c)
        # 上方气焰
        for k in (-1,0,1):
            x0=cx+k*R*0.6
            d.polygon([(x0-R*0.22,cy-R*1.1),(x0,cy-R*1.75),(x0+R*0.22,cy-R*1.1)],fill=c)
    else:  # used
        d.ellipse([cx-R*0.9,cy-R*0.9,cx+R*0.9,cy+R*0.9],outline=c,width=max(2,S//16))
        d.line([cx-R*0.75,cy+R*0.75,cx+R*0.75,cy-R*0.75],fill=c,width=max(3,S//12))
    return im.resize((size,size),Image.LANCZOS)

heart().save(f'{OUT}/icon_heart.png')
bolt(filled=True).save(f'{OUT}/icon_bolt_on.png')
bolt(filled=False).save(f'{OUT}/icon_bolt_off.png')
for k in ('idle','ready','used'):
    ult(k).save(f'{OUT}/ult_{k}.png')
print('icons ok')
