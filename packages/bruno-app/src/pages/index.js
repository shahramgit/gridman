import { useEffect } from 'react';
import Bruno from './Bruno';
import GlobalStyle from '../globalStyles';
import '../i18n';
import Main from './Main';
import { setupGlobalSelectionDataTools } from 'utils/codemirror/selectionDataTools';

export default function App() {
  useEffect(() => {
    return setupGlobalSelectionDataTools();
  }, []);

  return (
    <div>
      <main>
        <Main>
          <GlobalStyle />
          <Bruno />
        </Main>
      </main>
    </div>
  );
}
