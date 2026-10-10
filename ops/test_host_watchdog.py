import unittest
from host_watchdog import advance_alerts, cpu_percent, cpu_sample, pressure_candidates

class WatchdogTests(unittest.TestCase):
    def test_cpu_delta_and_guest_time(self):
        a = cpu_sample('cpu 100 10 20 1000 50 2 3 0 10 0\n')
        b = cpu_sample('cpu 150 10 30 1020 50 2 3 0 10 0\n')
        self.assertEqual(cpu_percent(a, b), 75)
        self.assertIsNone(cpu_percent(b, a))
    def test_sustained_alert_then_recovery(self):
        previous = {}
        for time in [100, 160]:
            previous, alerts, recovered = advance_alerts(previous, {'cpu': ('warning', 'High CPU')}, time)
            self.assertEqual(alerts, [])
        previous, alerts, _ = advance_alerts(previous, {'cpu': ('warning', 'High CPU')}, 220)
        self.assertEqual([a['id'] for a in alerts], ['cpu'])
        previous, alerts, recovered = advance_alerts(previous, {}, 280)
        self.assertEqual(alerts, [])
        self.assertEqual(recovered, ['cpu'])
    def test_hanging_loop_and_missing_container_are_not_healthy(self):
        metrics = {'cpuPercent': 0, 'memoryAvailableBytes': 8*1024**3, 'memoryTotalBytes': 16*1024**3,
                   'diskUsedPercent': 55, 'diskFreeBytes': 35*1024**3, 'workerResponsive': True, 'workerProgressAgeSeconds': 190}
        found = pressure_candidates(metrics, [{'name': 'worker', 'state': 'missing', 'healthy': False}], [])
        self.assertEqual(set(found), {'worker-stall', 'container:worker'})

if __name__ == '__main__': unittest.main()
