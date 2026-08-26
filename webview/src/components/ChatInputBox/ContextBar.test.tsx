import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContextBar } from './ContextBar';

const createProps = (): ComponentProps<typeof ContextBar> => ({
  t: ((key: string) => key) as never,
  onAddAttachment: vi.fn(),
  onClearAgent: vi.fn(),
  showUsage: false,
  hasMessages: false,
  statusPanelExpanded: false,
  onToggleStatusPanel: vi.fn(),
});

describe('ContextBar trigger symbol buttons', () => {
  it('renders / @ ! buttons and calls onTriggerInsert on click', () => {
    const onTriggerInsert = vi.fn();
    render(
      <ContextBar
        {...createProps()}
        onTriggerInsert={onTriggerInsert}
      />,
    );

    const slashBtn = screen.getByRole('button', { name: 'chat.triggerSlashCommand' });
    const atBtn = screen.getByRole('button', { name: 'chat.triggerReferenceFile' });
    const exclamationBtn = screen.getByRole('button', { name: 'chat.triggerInsertPrompt' });

    expect(slashBtn).toBeTruthy();
    expect(atBtn).toBeTruthy();
    expect(exclamationBtn).toBeTruthy();

    fireEvent.click(slashBtn);
    expect(onTriggerInsert).toHaveBeenCalledWith('/');

    fireEvent.click(atBtn);
    expect(onTriggerInsert).toHaveBeenCalledWith('@');

    fireEvent.click(exclamationBtn);
    expect(onTriggerInsert).toHaveBeenCalledWith('!');
  });

  it('does not render trigger buttons when onTriggerInsert is not provided', () => {
    render(<ContextBar {...createProps()} />);

    expect(screen.queryByRole('button', { name: 'chat.triggerSlashCommand' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.triggerReferenceFile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.triggerInsertPrompt' })).toBeNull();
  });
});
