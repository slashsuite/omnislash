# OB-2161 (HC-317): arm a per-thread CPU-time timer the way a browser's hang watchdog does. Under a finite
# RLIMIT_RTTIME hard limit of 0 the kernel SIGKILLs the process (exit 137) before the first hit; with the
# limit unlimited it prints its hits and exits 0.
import ctypes, signal, sys, time

librt = ctypes.CDLL(None, use_errno=True)
CLOCK_THREAD_CPUTIME_ID = 3
hits = 0

def on_alarm(_sig, _frame):
    global hits
    hits += 1

signal.signal(signal.SIGALRM, on_alarm)

class timespec(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]

class itimerspec(ctypes.Structure):
    _fields_ = [("it_interval", timespec), ("it_value", timespec)]

timer = ctypes.c_void_p()
# A NULL sigevent delivers SIGALRM to the process.
if librt.timer_create(CLOCK_THREAD_CPUTIME_ID, None, ctypes.byref(timer)) != 0:
    sys.exit(f"timer_create failed: errno {ctypes.get_errno()}")
spec = itimerspec(timespec(0, 50_000_000), timespec(0, 50_000_000))
if librt.timer_settime(timer, 0, ctypes.byref(spec), None) != 0:
    sys.exit(f"timer_settime failed: errno {ctypes.get_errno()}")

end = time.monotonic() + 1.5
while time.monotonic() < end:
    pass
# OB-2171: disarm before exit. Interpreter shutdown resets SIGALRM to its default action (terminate) while the
# timer is still armed, so a tick landing in the last CPU of shutdown killed the fixture with exit 142, about
# 1 run in 50. Ignore any tick already pending too.
if librt.timer_delete(timer) != 0:
    sys.exit(f"timer_delete failed: errno {ctypes.get_errno()}")
signal.signal(signal.SIGALRM, signal.SIG_IGN)
print(f"timer hits: {hits}")
sys.exit(0 if hits > 0 else 1)
