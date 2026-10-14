import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { Login } from '../src/components/Login';

afterEach(() => vi.restoreAllMocks());

async function submit(password = 'pw') {
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('Login', () => {
  it('calls onSuccess after a successful login', async () => {
    vi.spyOn(api, 'login').mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} />);
    await submit('secret');
    expect(api.login).toHaveBeenCalledWith('secret');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows "Wrong password" for 401', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError(401, 'unauthorized', 'Wrong password'));
    render(<Login onSuccess={() => {}} />);
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows "Too many attempts" for 429 rate_limited', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError(429, 'rate_limited', 'Too many failed logins; try again later'));
    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} />);
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows the error message for other failures', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError(0, 'network_error', 'Failed to fetch'));
    render(<Login onSuccess={() => {}} />);
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });
});
