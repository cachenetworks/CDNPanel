'use client';
import * as React from 'react';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';

/** CodeMirror with the language picked from the file name (loaded on demand). */
export default function CodeEditor({ value, onChange, filename, wrap, dark, onSave }: { value: string; onChange: (v: string) => void; filename: string; wrap: boolean; dark: boolean; onSave: () => void }) {
  const [language, setLanguage] = React.useState<Extension | null>(null);
  const saveRef = React.useRef(onSave);
  saveRef.current = onSave;

  React.useEffect(() => {
    let cancelled = false;
    const desc = LanguageDescription.matchFilename(languages, filename) ?? (filename.toLowerCase().endsWith('.luau') ? LanguageDescription.matchFilename(languages, 'x.lua') : null);
    setLanguage(null);
    if (desc) void desc.load().then((support) => !cancelled && setLanguage(support));
    return () => {
      cancelled = true;
    };
  }, [filename]);

  const extensions = React.useMemo(() => {
    const ext: Extension[] = [
      EditorView.domEventHandlers({
        keydown: (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveRef.current();
            return true;
          }
          return false;
        },
      }),
    ];
    if (wrap) ext.push(EditorView.lineWrapping);
    if (language) ext.push(language);
    return ext;
  }, [wrap, language]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={dark ? oneDark : 'light'}
      height="100%"
      className="h-full text-[13px]"
      basicSetup={{ highlightActiveLine: true, foldGutter: true, autocompletion: false, searchKeymap: true }}
    />
  );
}
