import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../common/types/request-user';
import { bookThumbnailUrl, BookJobSubjects } from './book-job-subjects.service';

const viewer = { id: 4, active: true, isSuperuser: false, permissions: [] } as unknown as RequestUser;
const COVER = new Date('2026-11-15T10:00:00.000Z');

function make() {
  const rows = new Map([
    [1, { title: 'Dune', coverUpdatedAt: COVER, authors: ['Frank Herbert'] }],
    [2, { title: 'Emma', coverUpdatedAt: null, authors: [] }],
  ]);
  const repository = {
    find: vi.fn((ids: number[]) => Promise.resolve(new Map([...rows].filter(([id]) => ids.includes(id))))),
  };
  const books = { verifyBookAccess: vi.fn((id: number) => (id === 2 ? Promise.reject(new NotFoundException()) : Promise.resolve())) };
  return { subjects: new BookJobSubjects(repository as never, books as never), repository, books };
}

describe('BookJobSubjects', () => {
  it('names each book once, with its authors, page and versioned cover', async () => {
    const { subjects, repository, books } = make();
    books.verifyBookAccess.mockResolvedValue(undefined);
    const found = await subjects.describe([1, 1, 2], viewer);
    expect(repository.find).toHaveBeenCalledWith([1, 2]);
    expect(found.get(1)).toEqual({ label: 'Dune', byline: 'Frank Herbert', url: '/book/1', image: bookThumbnailUrl(1, COVER) });
    expect(found.get(2)).toMatchObject({ label: 'Emma', byline: null, image: '/api/v1/books/2/thumbnail' });
  });

  it('leaves out a book even for an administrator without a current grant', async () => {
    const { subjects, books } = make();
    const admin = { ...viewer, isSuperuser: true };
    const found = await subjects.describe([1, 2], admin);
    expect(books.verifyBookAccess).toHaveBeenCalledTimes(2);
    expect([...found.keys()]).toEqual([1]);
  });

  it('lets an unexpected failure surface instead of hiding the book', async () => {
    const { subjects, books } = make();
    books.verifyBookAccess.mockRejectedValue(new ForbiddenException());
    await expect(subjects.describe([1], viewer)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
