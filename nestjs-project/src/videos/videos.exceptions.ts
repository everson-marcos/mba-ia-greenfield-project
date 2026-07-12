import { DomainException } from '../common/exceptions/domain.exception';

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 400, 'File size exceeds the 10GB limit');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'You do not own this video');
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super('UPLOAD_ALREADY_COMPLETED', 409, 'Upload has already been completed');
  }
}

export class InvalidUploadPartException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PART',
      400,
      "Uploaded part does not match storage's record",
    );
  }
}

export class MultipartUploadFailedException extends DomainException {
  constructor() {
    super(
      'MULTIPART_UPLOAD_FAILED',
      502,
      'Storage failed to complete the multipart upload',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback yet');
  }
}
