# 合成 8 段状态音效（16kHz 单声道），随后转成 ogg/opus 供固件 EMBED_FILES 使用
import math, wave, os, random, subprocess
SR=16000
OUT='/tmp/hud/assets/sounds'; os.makedirs(OUT, exist_ok=True)
random.seed(7)

def env(t, dur, a=0.01, d=0.12, s=0.0):
    if t < a: return t/a
    if t < a+d: return 1 - (1-s)*(t-a)/d
    return s

def tone(freq, t, amp=0.5, harm=0.0):
    v = math.sin(2*math.pi*freq*t)
    if harm: v += harm*math.sin(2*math.pi*freq*2*t)
    return amp*v

def write(name, samples, dur):
    buf=[max(-1.0,min(1.0,x))*0.85 for x in samples]
    path=f'/tmp/hud/assets/sounds/{name}.wav'
    with wave.open(path,'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b''.join(int(v*32767).to_bytes(2,'little',signed=True) for v in buf))
    return path

def seq(notes, gap=0.0, tail=0.2):
    # notes: [(起始秒, 时长, 频率, 幅度, 谐波)]
    dur=max(t0+d for t0,d,_,_,_ in notes)+tail
    n=int(dur*SR); out=[0.0]*n
    for t0,d,f,a,h in notes:
        for i in range(int(d*SR)):
            t=i/SR
            out[int(t0*SR)+i]+=tone(f,t,a,h)*env(t,d,a=min(0.012,d*0.2),d=d*0.8,s=0.0)
    return out, dur

def noise_burst(dur, amp=0.5, lp=0.2):
    n=int(dur*SR); out=[]; prev=0.0
    for i in range(n):
        x=random.uniform(-1,1)
        prev=prev+lp*(x-prev)
        out.append(amp*prev*env(i/SR,dur,a=0.005,d=dur*0.9,s=0.0))
    return out, dur

# 1 待命->可行动：轻柔双音提示
s,d=seq([(0.00,0.18,784,0.35,0.2),(0.14,0.30,1046,0.32,0.2)], tail=0.12)
write('ready',s,d)
# 2 进攻：下扫 + 噪声
s,d=seq([(0.00,0.22,620,0.30,0.4)], tail=0.04)
nz,_=noise_burst(0.22,0.35,0.35)
for i in range(min(len(nz),len(s))): s[i]+=nz[i]*0.8
write('attack',s,d)
# 3 受击：低频闷击 + 破音
s,d=seq([(0.00,0.28,120,0.85,0.5),(0.00,0.16,260,0.25,1.2)], tail=0.06)
nz,_=noise_burst(0.10,0.5,0.6)
for i in range(min(len(nz),len(s))): s[i]+=nz[i]
write('hurt',s,d)
# 4 格挡：金属短击
s,d=seq([(0.00,0.20,420,0.45,0.9),(0.00,0.14,630,0.3,0.6)], tail=0.05)
write('guard',s,d)
# 5 闪避成功：快速上扫风声 + 轻音
s,d=seq([(0.03,0.16,900,0.22,0.1)], tail=0.04)
nz,_=noise_burst(0.20,0.3,0.8)
for i in range(min(len(nz),len(s))): s[i]+=nz[i]*0.9
write('dodge',s,d)
# 6 大招就绪：上行琶音 + 长尾
s,d=seq([(0.00,0.16,523,0.30,0.2),(0.12,0.16,659,0.30,0.2),(0.24,0.16,784,0.30,0.2),(0.36,0.55,1046,0.34,0.25)], tail=0.25)
write('ult',s,d)
# 7 胜利：欢快四音
s,d=seq([(0.00,0.16,523,0.32,0.2),(0.14,0.16,659,0.32,0.2),(0.28,0.16,784,0.32,0.2),(0.42,0.55,1046,0.36,0.3)], tail=0.3)
write('victory',s,d)
# 8 失败：下行小三度
s,d=seq([(0.00,0.28,392,0.30,0.15),(0.24,0.30,330,0.30,0.15),(0.50,0.60,262,0.32,0.15)], tail=0.35)
write('defeat',s,d)
print('wav ok')

for name in ['ready','attack','hurt','guard','dodge','ult','victory','defeat']:
    src=f'{OUT}/{name}.wav'; dst=f'{OUT}/{name}.ogg'
    subprocess.run(['ffmpeg','-y','-loglevel','error','-i',src,'-c:a','libopus','-b:a','24k','-ar','16000','-ac','1',dst],check=True)
    os.remove(src)
print('ogg ok')
