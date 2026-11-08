import json,subprocess,sys,time,urllib.request
W="wrk_654e443f5d0a"
def on():
    try: return [w['online'] for w in json.load(urllib.request.urlopen("http://127.0.0.1:3231/workers",timeout=2))['workers'] if w['id']==W][0]
    except Exception: return None
def wait(v,lim=120):
    t=time.time()
    while on()!=v:
        time.sleep(0.3)
        if time.time()-t>lim: return None
    return round(time.time()-t,1)
what=sys.argv[1]
if what=="daemon":
    subprocess.run(["ssh","-o","BatchMode=yes","miah@100.93.29.26","systemctl --user restart epaperclip-worker"])
    print("offline after",wait(False),"s; online after",wait(True),"s")
if what=="host":
    pid=int(open("host.pid").read()); subprocess.run(["kill",str(pid)]); time.sleep(1)
    subprocess.Popen("nohup ./run-host.sh > host2.log 2>&1 & echo $! > host.pid",shell=True)
    t=time.time()
    while on() is not True and time.time()-t<120: time.sleep(0.3)
    print("worker online after host restart",round(time.time()-t,1),"s", on())
