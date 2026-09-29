import { connect } from 'node:net';

/**
 * Kiểm tra sức khỏe proxy đầu ra (tương ứng kế hoạch triển khai §13.1, hợp đồng §2.4 `POST /admin/proxies/:id/check`).
 *
 * Chỉ xác thực khả năng kết nối TCP tới chính endpoint proxy, không xác thực toàn bộ chuỗi chuyển tiếp qua nó tới mục tiêu trên Internet —
 * việc sau cần một mục tiêu Internet luôn kết nối được làm bia ngắm thăm dò, điều này không thực tế trong môi trường offline/mạng nội bộ/CI,
 * và cũng không nên để "kiểm tra sức khỏe" phụ thuộc vào tính khả dụng của một dịch vụ bên ngoài. Đây là sự đánh đổi có chủ ý, ghi chú tại đây
 * để tránh việc sau này có người hiểu nhầm rằng nó xác thực khả năng chuyển tiếp proxy hoàn chỉnh.
 */

export interface ProxyCheckResult {
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}

export type ProxyChecker = (url: string, timeoutMs: number) => Promise<ProxyCheckResult>;

export const defaultProxyChecker: ProxyChecker = async (rawUrl, timeoutMs) => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, latencyMs: null, detail: '代理地址不是合法 URL，无法解析主机与端口' };
  }
  const host = parsed.hostname;
  if (host === '') {
    return { ok: false, latencyMs: null, detail: '代理地址缺少主机名' };
  }
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  const started = Date.now();

  return new Promise<ProxyCheckResult>((resolve) => {
    let settled = false;
    const socket = connect({ host, port, timeout: timeoutMs });

    const finish = (result: ProxyCheckResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - started, detail: 'TCP 连接成功' }));
    socket.once('timeout', () => finish({ ok: false, latencyMs: null, detail: `连接超时（${timeoutMs}ms）` }));
    socket.once('error', (error) => finish({ ok: false, latencyMs: null, detail: `连接失败：${error.message}` }));
  });
};
