import random,json,statistics
from pathlib import Path
N=6000
ATT={'light':(1,3,.2,.5),'heavy':(2,5,.2,.5),'ult':(4,9,.4,.3)}
POL=['light','heavy','reserve','rush','wait_empty','finish']
def choose(p,hp,enemy,ap,eap,left):
 if p=='light':return 'light'
 if p=='heavy':return 'heavy'
 if p=='reserve' or left==0:return 'heavy' if ap>=3 else 'light'
 ready=ap>=4
 wanted=p=='rush' or (p=='wait_empty' and eap==0) or (p=='finish' and enemy<=11)
 if ready and wanted:return 'ult'
 if not ready and wanted:return 'charge'
 return 'heavy' if ap>=3 else 'light'
def defense(hp,ap,move,save):
 if ap==0:return 'take'
 _,d,c,p=ATT[move]
 if save and ap<=2 and hp>d+2:return 'take'
 outcomes={'guard':[(d-2,1-c),(d,c)],'dodge':[(0,p),(d,(1-p)*(1-c)),(d+2,(1-p)*c)]}
 return min(outcomes,key=lambda k:(sum(pr for dam,pr in outcomes[k] if dam>=hp),sum(dam*pr for dam,pr in outcomes[k])))
def game(ps,limit,save):
 hp=[20,20];ap=[3,3];left=[limit,limit];first=[True,True];uses=[0,0];a=0;counts={'charge':0,'take':0,'attack':0}
 for turn in range(300):
  b=1-a
  if first[a]:first[a]=False
  else:ap[a]=min(5,ap[a]+2)
  move=choose(ps[a],hp[a],hp[b],ap[a],ap[b],left[a])
  if move=='charge':
   assert ap[a]<4;ap[a]=min(5,ap[a]+1);counts['charge']+=1
  else:
   cost,d,c,p=ATT[move];assert ap[a]>=cost;ap[a]-=cost;counts['attack']+=1
   if move=='ult':assert left[a]>0;left[a]-=1;uses[a]+=1
   res=defense(hp[b],ap[b],move,save)
   if res=='take':counts['take']+=1
   else:ap[b]-=1
   dodged=res=='dodge' and random.random()<p
   dam=0 if dodged else d+(2 if random.random()<c else 0)-(2 if res=='guard' else 0)
   hp[b]-=dam
   if hp[b]<=0:return a,turn+1,uses,counts
  a=b
 raise RuntimeError('turn cap')
out={}
for save in [False,True]:
 for limit in [999,1,2]:
  random.seed(1024)
  key=f'{limit}_'+('save' if save else 'adaptive');r={'matrix':{},'mirrors':{},'usage':{}}
  for x in POL:
   for y in POL:
    wins=0;length=[];u=[0,0];unused=[0,0];charge=0;take=0
    for i in range(N):
     w,n,uses,c=game((x,y),limit,save);wins+=w==0;length.append(n)
     for j in range(2):u[j]+=uses[j];unused[j]+=uses[j]==0
     charge+=c['charge'];take+=c['take']
    r['matrix'][x+','+y]=wins/N
    r['usage'][x+','+y]={'mean_ults':[v/N for v in u],'zero_ults':[v/N for v in unused]}
    if x==y:r['mirrors'][x]={'first_win':wins/N,'actions':statistics.mean(length),'p90':sorted(length)[int(.9*N)],'ults':sum(u)/N,'charges':charge/N,'forced_or_chosen_take':take/N}
  r['balanced_scores']={x:sum((r['matrix'][x+','+y]+1-r['matrix'][y+','+x])/2 for y in POL if y!=x)/(len(POL)-1) for x in POL}
  out[key]=r
  print(key,json.dumps({'scores':r['balanced_scores'],'mirrors':r['mirrors']}),flush=True)
Path('tests/simulation/limited_ults_results.json').write_text(json.dumps(out,indent=2))
