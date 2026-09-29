import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { ProxiesPage } from '../pages/ProxiesPage';
import type { ProxyView } from '../api';

const FULL_PLAINTEXT_ADDRESS = 'socks5://realuser:SuperSecretPass1@203.0.113.7:1080';
const MASKED_ADDRESS = 'socks5://***:***@203.0.113.7:1080';

const proxyFixture: ProxyView = {
  id: 'proxy_1',
  name: 'Node egress-Test',
  url_masked: MASKED_ADDRESS,
  protocol: 'socks5',
  enabled: true,
  weight: 10,
  priority: 1,
  status: 'healthy',
  latency_ms: 42,
  last_check_at: Date.now(),
  failure_count: 0,
  cooldown_until: null,
  bound_accounts: [],
};

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listProxies: () => Promise.resolve([proxyFixture]),
    },
  };
});

describe('Che giấu địa chỉ proxy pool', () => {
  it('Danh sách chỉ render địa chỉ đã che, địa chỉ đầy đủ (gồm user/pass) không xuất hiện trong DOM', async () => {
    render(
      <MemoryRouter initialEntries={['/proxies']}>
        <AuthProvider>
          <ProxiesPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(MASKED_ADDRESS)).toBeTruthy();
    expect(document.body.textContent?.includes(FULL_PLAINTEXT_ADDRESS)).toBe(false);
    expect(document.body.textContent?.includes('SuperSecretPass1')).toBe(false);
    expect(document.body.innerHTML.includes('SuperSecretPass1')).toBe(false);
  });
});
