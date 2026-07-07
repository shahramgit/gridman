import find from 'lodash/find';

export const isItemARequest = (item) => {
  return item.hasOwnProperty('request') && ['http-request', 'graphql-request', 'grpc-request', 'ws-request'].includes(item.type);
};

export const isItemAFolder = (item) => {
  return !item.hasOwnProperty('request') && item.type === 'folder';
};

export const itemIsOpenedInTabs = (item, tabs) => {
  return find(tabs, (t) => t.uid === item.uid);
};

const normalizeTabPath = (p) => String(p || '').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '');

// Does a request tab represent the given sidebar request node? Covers both
// tab-identity styles the app produces for the same request:
//  - indexed sidebar opens carry a synthetic uid + itemPathname
//  - the new-request task middleware (curl paste, New Request) opens a tab
//    keyed by the request's real uid (== node.uid) and itemUid
// Matching on any of these keeps a double-click from opening a duplicate tab
// for a request that is already open under a different identity.
export const doesTabMatchRequestNode = (tab, { collectionUid, pathname, uid } = {}) => {
  if (!tab || tab.collectionUid !== collectionUid) {
    return false;
  }
  if (tab.itemPathname && pathname && normalizeTabPath(tab.itemPathname) === normalizeTabPath(pathname)) {
    return true;
  }
  return Boolean(uid) && (tab.uid === uid || tab.itemUid === uid);
};

export const scrollToTheActiveTab = () => {
  const activeTab = document.querySelector('.request-tab.active');
  if (activeTab) {
    // 'nearest' scrolls only when the tab is out of view — 'start' also
    // shifted vertical ancestors, nudging the layout on every click.
    activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
};
