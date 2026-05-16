import React from 'react';
import Modal from 'components/Modal/index';
import { IconBrandGithub, IconHeart, IconGitBranch, IconFolder, IconShieldLock } from '@tabler/icons';
import StyledWrapper from './StyledWrapper';
import { useTheme } from 'providers/Theme/index';

const projectHighlights = [
  {
    icon: IconFolder,
    text: 'Workspace-owned collections'
  },
  {
    icon: IconGitBranch,
    text: 'Workspace-level Git sync'
  },
  {
    icon: IconShieldLock,
    text: 'Local-first storage'
  }
];

const GoldenEdition = ({ onClose }) => {
  const { displayedTheme } = useTheme();
  const themeBasedContainerClassNames = displayedTheme === 'light' ? 'text-gray-900' : 'text-white';

  return (
    <StyledWrapper>
      <Modal size="sm" title="Support Gridman" handleCancel={onClose} hideFooter={true}>
        <div className={`flex flex-col w-full ${themeBasedContainerClassNames}`}>
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">Support Gridman</h3>
            <a
              href="https://github.com/shahramgit/gridman"
              target="_blank"
              rel="noreferrer"
              className="flex text-white bg-yellow-600 hover:bg-yellow-700 font-medium rounded-lg px-4 py-2 text-center cursor-pointer"
            >
              <IconBrandGithub size={18} strokeWidth={1.5} /> <span className="ml-2">GitHub</span>
            </a>
          </div>
          <p className="mt-4">
            Gridman is an open-source fork focused on predictable workspace storage and Git-based team workflows.
          </p>
          <ul role="list" className="space-y-3 text-left mt-6">
            <li className="flex items-center space-x-3">
              <IconHeart className="flex-shrink-0 w-5 h-5 text-yellow-600" />
              <span>Star the project, report issues, and contribute improvements.</span>
            </li>
            {projectHighlights.map(({ icon: Icon, text }) => (
              <li className="flex items-center space-x-3" key={text}>
                <Icon className="flex-shrink-0 w-5 h-5 text-green-500" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    </StyledWrapper>
  );
};

export default GoldenEdition;
