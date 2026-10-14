import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ErrorDialog from '../dialogs/ErrorDialog'
import { useAppState } from '@/hooks/useAppState'

const successToast = vi.fn()
const errorToast = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => successToast(...args),
    error: (...args: unknown[]) => errorToast(...args),
  },
}))
describe('ErrorDialog', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    })
    useAppState.setState({
      errorMessage: undefined,
    })
  })

  afterEach(() => {
    useAppState.setState({
      errorMessage: undefined,
    })
  })

  it('renders the dialog when there is an error message', () => {
    useAppState.setState({
      errorMessage: {
        title: 'MCP startup failed',
        subtitle: 'Please check the parameters according to the tutorial.',
        message: 'Failed to start MCP server NotesMCP',
      },
    })

    render(<ErrorDialog />)

    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByText('MCP startup failed')).toBeInTheDocument()
    expect(screen.getByText('Failed to start MCP server NotesMCP')).toBeInTheDocument()
  })

  it('clears the global error state when dismissed', async () => {
    useAppState.setState({
      errorMessage: {
        subtitle: 'Please check the parameters according to the tutorial.',
        message: 'Failed to start MCP server NotesMCP',
      },
    })

    render(<ErrorDialog />)

    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => {
      expect(useAppState.getState().errorMessage).toBeUndefined()
    })
  })

  it('copies the error details to the clipboard', async () => {
    writeText.mockResolvedValue(undefined)
    useAppState.setState({
      errorMessage: {
        subtitle: 'Please check the parameters according to the tutorial.',
        message: 'stderr details',
      },
    })

    render(<ErrorDialog />)

    fireEvent.click(screen.getByText('Copy'))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('stderr details')
      expect(successToast).toHaveBeenCalledWith('Copy successful', {
        id: 'copy-error',
        description: 'Error information copied to clipboard',
      })
    })
  })

  it('shows a translated error toast when copying fails', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    useAppState.setState({
      errorMessage: {
        subtitle: 'Please check the parameters according to the tutorial.',
        message: 'stderr details',
      },
    })

    render(<ErrorDialog />)

    fireEvent.click(screen.getByText('Copy'))

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith('Failed to copy', {
        id: 'copy-error-failed',
        description: 'Failed to copy error information to clipboard',
      })
    })
  })

  it('hides the details until expanded state is toggled', () => {
    useAppState.setState({
      errorMessage: {
        subtitle: 'Please check the parameters according to the tutorial.',
        message: 'long stderr details',
      },
    })

    render(<ErrorDialog />)

    expect(screen.getByText('long stderr details')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.queryByText('long stderr details')).not.toBeInTheDocument()
  })

  it('renders the translated fallback title when no title is provided', () => {
    useAppState.setState({
      errorMessage: {
        subtitle: 'Please check the parameters according to the tutorial.',
        message: 'stderr details',
      },
    })

    render(<ErrorDialog />)

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument()
  })
})
