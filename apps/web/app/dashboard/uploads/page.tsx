'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { UploadCloud } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { VISIBILITIES, type FolderDTO, type Visibility } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Field, NativeSelect } from '@/components/ui/form';
import { EmptyState, PageHeader, Panel, Section } from '@/components/ui/misc';
import { Dropzone } from '@/components/uploads/dropzone';
import { UploadList } from '@/components/uploads/upload-list';
import { useUploads } from '@/components/uploads/upload-manager';
import { useSession } from '@/lib/session';

export default function UploadsPage() {
  const { items, enqueue, clearFinished } = useUploads();
  const { can } = useSession();
  const [folderId, setFolderId] = React.useState('');
  const [visibility, setVisibility] = React.useState<Visibility | ''>('');
  const folders = useQuery({ queryKey: ['folders', 'all'], queryFn: () => api<Paginated<FolderDTO>>('/folders', { query: { all: 'true', limit: 500 } }) });
  const folder = folders.data?.data.find((f) => f.id === folderId);

  return (
    <>
      <PageHeader title="Uploads" description="Upload files from your browser. Files over 64 MB are sent in resumable chunks and verified with SHA-256." />
      {can('files.upload') ? (
        <Section>
          <div className="mb-3 flex flex-wrap gap-4">
            <Field label="Destination folder">
              <NativeSelect className="min-w-[240px]" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">/ (root)</option>
                {(folders.data?.data ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Visibility">
              <NativeSelect value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility | '')}>
                <option value="">Folder / default</option>
                {VISIBILITIES.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Dropzone onFiles={(files) => enqueue(files, { folderId: folderId || null, folderLabel: folder?.path ?? '/', visibility: visibility || undefined })} />
        </Section>
      ) : (
        <p className="mb-6 text-sm text-muted-foreground">Your role cannot upload files.</p>
      )}
      <Section
        title="Upload queue"
        description="Uploads run three at a time and continue while you navigate the dashboard."
        actions={
          items.some((i) => i.status === 'complete' || i.status === 'failed' || i.status === 'cancelled') && (
            <Button size="sm" variant="secondary" onClick={clearFinished}>
              Clear finished
            </Button>
          )
        }
      >
        <Panel>{items.length ? <UploadList /> : <EmptyState icon={UploadCloud} title="No uploads in this session" description="Files you upload will appear here with progress, speed and status." />}</Panel>
      </Section>
    </>
  );
}
