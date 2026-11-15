# SPDX-License-Identifier: CPAL-1.0
import os, sys, threading, time, unittest
PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)
from engine import gep  # noqa: E402


def make_conn():
    frames = []
    lock = threading.Lock()
    conn = gep.Conn(write=lambda obj: (lock.acquire(), frames.append(obj), lock.release()))
    return conn, frames


class HeartbeatTest(unittest.TestCase):
    def test_sends_periodic_heartbeats(self):
        conn, frames = make_conn()
        hb = gep.Heartbeat(conn, interval_s=0.05)
        hb.start()
        time.sleep(0.4)
        hb.stop()
        beats = [f for f in frames if f.get('method') == 'gep.heartbeat']
        self.assertGreaterEqual(len(beats), 4)
        self.assertTrue(all(isinstance(b['params']['ts'], int) for b in beats))
        self.assertEqual(conn.out, [])            # 不进诊断列表

    def test_not_blocked_by_cpu_bound_thread(self):
        conn, frames = make_conn()
        hb = gep.Heartbeat(conn, interval_s=0.05)
        hb.start()
        stop = time.monotonic() + 0.6
        def burn():
            x = 0
            while time.monotonic() < stop:
                x += 1
        t = threading.Thread(target=burn); t.start(); t.join()
        hb.stop()
        beats = [f for f in frames if f.get('method') == 'gep.heartbeat']
        self.assertGreaterEqual(len(beats), 6)    # 忙等 0.6 s 里仍照发

    def test_bind_changes_interval_and_clamps(self):
        conn, frames = make_conn()
        hb = gep.Heartbeat(conn, interval_s=60.0)  # 初始周期很长
        hb.start()
        hb.set_interval_ms(10)                     # 夹到 250 ms
        time.sleep(0.7)
        hb.stop()
        beats = [f for f in frames if f.get('method') == 'gep.heartbeat']
        self.assertTrue(1 <= len(beats) <= 3)      # 不是 60 s 才一条，也不是 10 ms 一条

    def test_stop_ends_thread_and_write_failure_ends_it(self):
        conn = gep.Conn(write=lambda obj: (_ for _ in ()).throw(OSError('closed')))
        hb = gep.Heartbeat(conn, interval_s=0.02)
        hb.start()
        time.sleep(0.15)
        self.assertFalse(hb._thread.is_alive())    # 写失败后自己退出，不抛到外面

    def test_hello_does_not_start_thread_in_unit_tests(self):
        conn, _ = make_conn()
        conn.token = 't'
        gep.hello(conn, 1, {'versions': ['0.1'], 'auth': {'token': 't'}})
        self.assertIsNone(getattr(conn, 'heartbeat', None))   # 只有 serve() 才挂线程


if __name__ == '__main__':
    unittest.main()
