import json,time,urllib.request
pid="bdfaa68d8984f0dc02beaca527b76f20"
sel="We compute the dot products of the query with all keys, divide each by sqrt(dk), and apply a softmax function to obtain the weights on the values."
out={}
for intent in ["explain","visualize"]:
    body=json.dumps({"selection":sel,"page":4,"intent":intent,"provider":"ollama"}).encode()
    req=urllib.request.Request(f"http://127.0.0.1:8000/api/papers/{pid}/ask",data=body,headers={"Content-Type":"application/json"})
    t=time.time()
    with urllib.request.urlopen(req,timeout=280) as r:
        for line in r:
            line=line.decode().strip()
            if line.startswith("data: "):
                e=json.loads(line[6:])
                if e["type"] in("result","error"): out[intent]=e
    print(intent,round(time.time()-t,1),out[intent]["type"],out[intent].get("check"),out[intent].get("message",""))
json.dump(out,open("brag-output/work/answers.json","w"),indent=1,ensure_ascii=False)
print(out["explain"].get("markdown"))
v=out["visualize"].get("visual") or {}
print(v.get("form"),"|",v.get("caption"));print(v.get("code"))
