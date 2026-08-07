/** The boundary exists because one malformed SSE frame once took out the
 *  whole window. These pin the two halves of its contract: a crash renders
 *  the fallback instead of white, and "Try again" really re-renders. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../components/ErrorBoundary';

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('malformed frame');
  return <p>alive</p>;
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><p>alive</p></ErrorBoundary>);
    expect(screen.getByText('alive')).toBeInTheDocument();
  });

  it('catches a render crash and keeps the rest of the app standing', () => {
    // React logs caught errors loudly; that noise is the boundary WORKING.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary label="The transcript">
        <Bomb armed />
      </ErrorBoundary>,
    );
    quiet.mockRestore();
    expect(screen.getByText(/The transcript hit an error/)).toBeInTheDocument();
    expect(screen.getByText(/malformed frame/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
