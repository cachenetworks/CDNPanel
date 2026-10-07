import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Folder } from 'lucide-react';
import { cn, fileKind } from '@/lib/utils';

export function FileIcon({ mime, className }: { mime: string; className?: string }) {
  const kind = fileKind(mime);
  const Icon = { image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, text: FileText, archive: FileArchive, other: File }[kind];
  return <Icon className={cn('h-4 w-4 shrink-0 text-muted-foreground', className)} />;
}

export function FolderIcon({ className }: { className?: string }) {
  return <Folder className={cn('h-4 w-4 shrink-0 fill-[hsl(var(--primary)/0.15)] text-primary', className)} />;
}
