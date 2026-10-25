exec(open('test/simulation/pace_tuning.py').read().split('configs=')[0])
oldchoose=choose
POL=['light','heavy','reserve','rush','wait_empty','finish','prepared','adaptive_finish']
def choose(p,hp,enemy,ap,eap,left):
 if p not in ['prepared','adaptive_finish']:return oldchoose(p,hp,enemy,ap,eap,left)
 if not left:return 'heavy' if ap>=3 else 'light'
 d=ATT['ult'][1]
 if ap>=4 and ((p=='prepared' and eap==0) or (p=='adaptive_finish' and enemy<=d+2)):return 'ult'
 if ap<4 and hp>ATT['heavy'][1]+2:return 'charge'
 return 'heavy' if ap>=3 else 'light'
olddef=defense
stats={}
def defense(hp,ap,move,save):
 r=olddef(hp,ap,move,save)
 key=(current_round,move,r);stats[key]=stats.get(key,0)+1
 return r
# Inject counters, with otherwise identical simulation rules.
import inspect
source=open('test/simulation/pace_tuning.py').read().split('def run(')[1].split('configs=')[0]
source='def run('+source
source=source.replace('b=1-a;rd=turn//2+1;','global current_round\n  b=1-a;rd=turn//2+1;current_round=rd;')
exec(source)
random.seed(20261023);N=2000;out={};allrounds=[]
for save in [False,True]:
 matrix={};mirror={};rounds=[]
 for x in POL:
  for y in POL:
   wins=0;ls=[]
   for _ in range(N):
    w,n=run((x,y),14,4,2,3,save);wins+=w==0;ls.append(n)
   rounds+=ls;matrix[x+','+y]=wins/N
   if x==y:mirror[x]={'first_win':wins/N,'mean_rounds':statistics.mean(ls),'target':sum(3<=n<=5 for n in ls)/N}
 out[str(save)]={'matrix':matrix,'mirror':mirror,'mean_rounds':statistics.mean(rounds),'target':sum(3<=n<=5 for n in rounds)/len(rounds),'first_win':statistics.mean(matrix.values()),'scores':{x:sum((matrix[x+','+y]+1-matrix[y+','+x])/2 for y in POL if y!=x)/(len(POL)-1) for x in POL}}
 allrounds+=rounds
out['overall']={'games':len(allrounds),'target':sum(3<=n<=5 for n in allrounds)/len(allrounds),'early':sum(n<3 for n in allrounds)/len(allrounds),'late':sum(n>5 for n in allrounds)/len(allrounds),'mean':statistics.mean(allrounds),'p90':sorted(allrounds)[int(.9*len(allrounds))],'p95':sorted(allrounds)[int(.95*len(allrounds))]}
out['responses']={str(rd):{r:sum(v for (n,m,k),v in stats.items() if n==rd and k==r) for r in ['guard','dodge','take']} for rd in range(1,9)}
Path('test/simulation/v02_validation_results.json').write_text(json.dumps(out,indent=2))
print(json.dumps({k:v if k=='overall' or k=='responses' else {a:b for a,b in v.items() if a!='matrix'} for k,v in out.items()},indent=2))
