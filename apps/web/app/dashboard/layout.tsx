'use client';
import { SessionProvider } from '@/lib/session';
import { Shell } from '@/components/shell';
import { ConfirmProvider } from '@/components/confirm';
import { UploadProvider } from '@/components/uploads/upload-manager';
import { Spinner } from '@/components/ui/misc';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      }
    >
      <ConfirmProvider>
        <UploadProvider>
          <Shell>{children}</Shell>
        </UploadProvider>
      </ConfirmProvider>
    </SessionProvider>
  );
}
