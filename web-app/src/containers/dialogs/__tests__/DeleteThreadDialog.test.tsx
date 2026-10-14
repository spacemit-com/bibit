import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { DeleteThreadDialog } from '../DeleteThreadDialog'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('DeleteThreadDialog', () => {
  it('keeps the confirmation open and reports a failed deletion', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('Runtime 删除失败'))
    render(<DeleteThreadDialog thread={{ id: 's', title: '会话' } as Thread} onDelete={onDelete} open onOpenChange={vi.fn()} withoutTrigger />)
    fireEvent.click(screen.getByRole('button', { name: /^Delete/ }))
    expect(await screen.findByText('Runtime 删除失败')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
