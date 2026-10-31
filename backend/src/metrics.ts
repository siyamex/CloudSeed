/** Small in-process HTTP metrics, rendered together with database gauges in the Prometheus text format. */
const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface Series { count: number; sum: number; buckets: number[] }

export class HttpMetrics {
  private readonly series = new Map<string, Series>();
  private readonly started = Date.now();

  record(method: string, route: string, status: number, seconds: number) {
    const key = `${method}\u0000${route}\u0000${Math.floor(status / 100)}xx`;
    let s = this.series.get(key);
    if (!s) { s = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }; this.series.set(key, s); }
    s.count++; s.sum += seconds;
    BUCKETS.forEach((b, i) => { if (seconds <= b) s!.buckets[i]!++; });
  }

  render(): string {
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const out: string[] = [
      '# HELP cloudseed_http_request_duration_seconds HTTP request duration by route (the route pattern, never the URL).',
      '# TYPE cloudseed_http_request_duration_seconds histogram',
    ];
    for (const [key, s] of [...this.series].sort()) {
      const [method, route, cls] = key.split('\u0000') as [string, string, string];
      const l = `method="${method}",route="${esc(route)}",status="${cls}"`;
      BUCKETS.forEach((b, i) => out.push(`cloudseed_http_request_duration_seconds_bucket{${l},le="${b}"} ${s.buckets[i]}`));
      out.push(`cloudseed_http_request_duration_seconds_bucket{${l},le="+Inf"} ${s.count}`);
      out.push(`cloudseed_http_request_duration_seconds_sum{${l}} ${s.sum.toFixed(6)}`);
      out.push(`cloudseed_http_request_duration_seconds_count{${l}} ${s.count}`);
    }
    const mem = process.memoryUsage();
    out.push(
      '# TYPE cloudseed_process_resident_memory_bytes gauge', `cloudseed_process_resident_memory_bytes ${mem.rss}`,
      '# TYPE cloudseed_process_uptime_seconds gauge', `cloudseed_process_uptime_seconds ${Math.round((Date.now() - this.started) / 1000)}`,
    );
    return out.join('\n') + '\n';
  }
}

/** Renders `name{label="v"} value` lines for a gauge with one label. */
export function gauge(name: string, help: string, label: string | null, rows: [string, number][]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const [v, n] of rows) lines.push(label ? `${name}{${label}="${v.replace(/["\\\n]/g, '_')}"} ${n}` : `${name} ${n}`);
  return lines.join('\n') + '\n';
}
