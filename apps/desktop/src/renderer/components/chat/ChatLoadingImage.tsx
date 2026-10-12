import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** Keep a visible frame until the browser has received and decoded the image. */
export function ChatLoadingImage(props: ComponentProps<'img'>) {
  // A changed URL starts a fresh load, including late remote-origin resolution.
  return <ImageLoad key={props.src} {...props} />;
}

function ImageLoad({ onLoad, style, className, ...props }: ComponentProps<'img'>) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && (
        <span
          role="status"
          aria-label={t('chat.imageMissing.loading')}
          className="inline-flex min-h-[180px] w-[280px] max-w-full self-start items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-tertiary)]"
        >
          <Spinner size={16} aria-hidden="true" />
        </span>
      )}
      <img
        {...props}
        className={cn(
          className,
          loaded &&
            'motion-safe:animate-in motion-safe:fade-in [animation-duration:var(--motion-fast)] [animation-timing-function:var(--motion-ease-out)]',
        )}
        style={loaded ? style : { ...style, display: 'none' }}
        onLoad={(event) => {
          setLoaded(true);
          onLoad?.(event);
        }}
      />
    </>
  );
}
