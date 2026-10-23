exec(open('tests/simulation/limited_ults.py').read().split('out={}')[0])
import math
BASE=ATT.copy()
def run(ps,h,comp,ramp,start,save):
 hp=[h,h+comp];ap=[3,3];left=[1,1];first=[True,True];a=0
 for turn in range(100):
  b=1-a;rd=turn//2+1;bonus=max(0,rd-start+1)*ramp
  for k,(cost,d,c,p) in BASE.items():ATT[k]=(cost,d+bonus,c,p)
  if first[a]:first[a]=False
  else:ap[a]=min(5,ap[a]+2)
  move=choose(ps[a],hp[a],hp[b],ap[a],ap[b],left[a])
  if move=='charge':ap[a]=min(5,ap[a]+1)
  else:
   cost,d,c,p=ATT[move];ap[a]-=cost
   if move=='ult':left[a]-=1
   res=defense(hp[b],ap[b],move,save)
   if res!='take':ap[b]-=1
   dodge=res=='dodge' and random.random()<p
   hp[b]-=0 if dodge else d+(2 if random.random()<c else 0)-(2 if res=='guard' else 0)
   if hp[b]<=0:return a,rd
  a=b
 return -1,50
configs=[(20,0,0,3),(14,0,0,3),(16,0,0,3)]+[(h,c,r,3) for h in [16,20] for c in [0,2,3] for r in [1,2]]
res=[]
for h,c,r,s in configs:
 random.seed(627);lens=[];win=0;mirror={};scores={p:[0,0] for p in POL}
 for save in [False,True]:
  for x in POL:
   for y in POL:
    mw=0;ls=[]
    for _ in range(300):
     w,n=run((x,y),h,c,r,s,save);win+=w==0;mw+=w==0;lens.append(n);ls.append(n)
     scores[x][0]+=w==0;scores[x][1]+=1;scores[y][0]+=w==1;scores[y][1]+=1
    if x==y:mirror[x+str(save)]=[round(mw/300,3),round(statistics.mean(ls),2)]
 z={'cfg':[h,c,r,s],'first':win/len(lens),'target':sum(3<=n<=5 for n in lens)/len(lens),'early':sum(n<3 for n in lens)/len(lens),'late':sum(n>5 for n in lens)/len(lens),'mean':statistics.mean(lens),'p90':sorted(lens)[int(.9*len(lens))],'mirrors':mirror,'scores':{p:a/b for p,(a,b) in scores.items()}}
 res.append(z);print(json.dumps({k:v for k,v in z.items() if k not in ['mirrors','scores']}),flush=True)
Path('tests/simulation/pace_tuning_results.json').write_text(json.dumps(res,indent=2))
