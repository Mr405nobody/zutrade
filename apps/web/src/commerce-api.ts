export class CommerceApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function commerceRequest<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new CommerceApiError(0, '连接失败，请检查网络或 API 服务后重试。');
  }
  const data: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data ? String(data.message) : '请求未完成';
    throw new CommerceApiError(
      response.status,
      response.status === 409
        ? `版本冲突：${message}。已重新读取，请核对后再提交。`
        : response.status === 401
          ? '登录已失效，请重新登录。'
          : response.status === 403
            ? '当前成员没有此工厂或会话的访问权限。'
            : message,
    );
  }
  return data as T;
}
export function commerceDate(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString([], {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未设置';
}

// Display decimal strings without converting commercial values to JS floating point.
export function commerceDecimal(value: string, minimumFractionDigits = 0) {
  const [integer = '0', fraction = ''] = value.split('.');
  const significant = fraction.replace(/0+$/, '').padEnd(minimumFractionDigits, '0');
  return significant ? `${integer}.${significant}` : integer;
}
