export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;
export const PROCESS_VIDEO_JOB = 'process-video' as const;

export const MAX_VIDEO_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
export const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024; // 8MB fixed part size
