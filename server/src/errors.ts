/** Ошибка с HTTP-статусом: обработчик ошибок отдаёт её текст клиенту. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
