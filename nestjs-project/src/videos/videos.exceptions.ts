import { DomainException } from '../common/exceptions/domain.exception';

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 400, 'File size exceeds the 10GB limit');
  }
}
