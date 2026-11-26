import json,sys,hashlib,struct
A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58(s):
    n=0
    for c in s:n=n*58+A.index(c)
    b=n.to_bytes((n.bit_length()+7)//8,'big')
    return b'\x00'*(len(s)-len(s.lstrip('1')))+b
def b58e(b):
    n=int.from_bytes(b,'big');o=''
    while n:n,r=divmod(n,58);o=A[r]+o
    return '1'*(len(b)-len(b.lstrip(b'\0')))+o
idl=json.load(open('/workspace/ruggy/alpha-terminal/research/jupiter-feasibility/raw/probe/idl_jupiter-perpetuals-idl-json.json'))
types={t['name']:t['type'] for t in idl['types']}
ev={}
for e in idl['events']:
    ev[hashlib.sha256(('event:'+e['name']).encode()).digest()[:8]]=e
class R:
    def __init__(s,b):s.b=b;s.o=0
    def t(s,n):v=s.b[s.o:s.o+n];assert len(v)==n;s.o+=n;return v
def rd(r,t):
    if isinstance(t,str):
        f={'u8':'<B','u16':'<H','u32':'<I','u64':'<Q','i64':'<q','i32':'<i','bool':'<?','u128':'<QQ','i128':'<qq'}
        if t=='publicKey':return b58e(r.t(32))
        if t in('u128','i128'):
            lo,hi=struct.unpack(f[t],r.t(16));return lo+(hi<<64)
        return struct.unpack(f[t],r.t(struct.calcsize(f[t])))[0]
    if 'option' in t:return rd(r,t['option']) if r.t(1)[0] else None
    if 'defined' in t:
        d=types[t['defined']]
        if d['kind']=='enum':
            i=r.t(1)[0];v=d['variants'][i];return v['name'] if 'fields' not in v else {v['name']:[rd(r,f if isinstance(f,(str,dict)) else f['type']) for f in v['fields']]}
        return {f['name']:rd(r,f['type']) for f in d['fields']}
    if 'array' in t:return [rd(r,t['array'][0]) for _ in range(t['array'][1])]
    if 'vec' in t:return [rd(r,t['vec']) for _ in range(struct.unpack('<I',r.t(4))[0])]
    raise Exception(t)
def events(tx):
    res=tx['result'];keys=res['transaction']['message']['accountKeys']+res['meta'].get('loadedAddresses',{}).get('writable',[])+res['meta'].get('loadedAddresses',{}).get('readonly',[])
    out=[]
    for ii in res['meta'].get('innerInstructions',[]):
        for ins in ii['instructions']:
            if keys[ins['programIdIndex']]!='PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu':continue
            d=b58(ins['data'])
            if d[:8]!=bytes.fromhex('e445a52e51cb9a1d'):continue
            e=ev.get(d[8:16])
            if not e:out.append(('UNKNOWN',d[8:16].hex()));continue
            r=R(d[16:]);out.append((e['name'],{f['name']:rd(r,f['type']) for f in e['fields']}))
    return out
if __name__=='__main__':
    for f in sys.argv[1:]:
        tx=json.load(open(f))
        for n,v in events(tx):print(f,n,json.dumps(v)[:1500])
