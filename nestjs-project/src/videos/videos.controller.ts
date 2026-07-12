import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartUrlQueryDto } from './dto/upload-part-url-query.dto';
import { VideoStatus } from './entities/video.entity';
import { VideosService, VideoStatusResult } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and start a multipart upload',
    description:
      "Creates the video as a draft (status: rascunho) for the authenticated user's channel and initiates a storage multipart upload.",
  })
  @ApiResponse({
    status: 201,
    description: 'Video draft created and multipart upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        uploadId: { type: 'string' },
        partSize: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or file size above the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<{ id: string; uploadId: string; partSize: number }> {
    return this.videosService.create(user.sub, dto);
  }

  @Get(':id/upload-part-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a presigned URL for a multipart upload part',
    description:
      "Returns a presigned URL the client uses to PUT one part of the video's multipart upload directly to storage.",
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part upload URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 403,
    description: 'Requester does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadPartUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: UploadPartUrlQueryDto,
  ): Promise<{ url: string }> {
    return this.videosService.getUploadPartUrl(user.sub, id, query.partNumber);
  }

  @Post(':id/complete-upload')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the multipart upload and enqueue processing',
    description:
      'Completes the storage multipart upload, moves the video to status: processando, and enqueues the background processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "A part's eTag does not match storage's record",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Requester does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Storage failed to complete the multipart upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the current status and metadata of a video',
    description:
      'Returns the video processing lifecycle status (rascunho → processando → pronto/erro) for the owner.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video status and metadata',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        status: { type: 'string' },
        durationSeconds: { type: 'number', nullable: true },
        errorMessage: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Requester does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoStatusResult> {
    return this.videosService.findOne(user.sub, id);
  }

  @Public()
  @Get(':id/stream')
  @ApiOperation({
    summary: 'Get a presigned streaming URL for a video',
    description:
      "Returns a presigned GET URL for the video's original file, supporting Range/206 playback. Public for videos with status: pronto.",
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('id') id: string): Promise<{ url: string }> {
    return this.videosService.getStreamUrl(id);
  }

  @Public()
  @Get(':id/download')
  @ApiOperation({
    summary: 'Get a presigned download URL for a video',
    description:
      "Returns a presigned GET URL for the video's original file with a Content-Disposition: attachment override. Public for videos with status: pronto.",
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('id') id: string): Promise<{ url: string }> {
    return this.videosService.getDownloadUrl(id);
  }
}
