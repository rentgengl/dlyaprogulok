/** Ошибка с HTTP-статусом: обработчик ошибок отдаёт её текст клиенту. */
export class HttpError extends Error {
  status: number;
  /** Машинный код для клиента (например, INSUFFICIENT_POINTS): по нему приложение выбирает реакцию. */
  code?: string;
  /** Дополнительные поля ответа, например { need, available }. */
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
