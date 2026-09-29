import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiRequestError } from '../api';

/**
 * Khung sườn chung để tải dữ liệu ở cấp độ trang: thống nhất 3 trạng thái loading / error / data,
 * tránh việc lặp lại try/catch ở nhiều trang. Hàm `reload` hỗ trợ làm mới dữ liệu sau các thao tác.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  // setLoading/setError/setData bên trong reload là các setter của useState, loaderRef là đối tượng ref,
  // tất cả đều ổn định qua các lần render; giá trị thay đổi cần kích hoạt reload chỉ là deps được truyền vào.
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => setData(result))
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setLoading(false));
  }, deps);

  // reload là giá trị bên ngoài duy nhất được tham chiếu trong effect này.
  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}
