import { Injectable, NotFoundException } from '@nestjs/common';
import type { JobSubject } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { BookJobSubjectsRepository } from './book-job-subjects.repository';
import { BookService } from './book.service';

const REACH_CONCURRENCY = 4;

/** A book's cover thumbnail, versioned so a new cover is fetched again. */
export function bookThumbnailUrl(bookId: number, coverUpdatedAt: Date | null): string {
  const version = coverUpdatedAt ? `?t=${coverUpdatedAt.getTime()}` : '';
  return `/api/v1/books/${bookId}/thumbnail${version}`;
}

/**
 * Job administration controls the job list. Book subjects still depend on the current
 * viewer's content access, so inaccessible or deleted books fall back to neutral text.
 */
@Injectable()
export class BookJobSubjects {
  constructor(
    private readonly repository: BookJobSubjectsRepository,
    private readonly books: BookService,
  ) {}

  async describe(bookIds: readonly number[], user: RequestUser): Promise<Map<number, JobSubject>> {
    const distinct = [...new Set(bookIds.filter(Number.isSafeInteger))];
    const reachable = await this.reachable(distinct, user);
    if (reachable.size === 0) return new Map();
    const found = await this.repository.find([...reachable]);
    const subjects = new Map<number, JobSubject>();
    for (const [bookId, book] of found) {
      subjects.set(bookId, {
        label: book.title,
        byline: book.authors.length > 0 ? book.authors.join(', ') : null,
        url: `/book/${bookId}`,
        image: bookThumbnailUrl(bookId, book.coverUpdatedAt),
      });
    }
    return subjects;
  }

  private async reachable(bookIds: number[], user: RequestUser): Promise<Set<number>> {
    const reached = await mapWithConcurrency(bookIds, REACH_CONCURRENCY, async (bookId) => {
      try {
        await this.books.verifyBookAccess(bookId, user);
        return bookId;
      } catch (error) {
        if (error instanceof NotFoundException) return null;
        throw error;
      }
    });
    return new Set(reached.filter((id): id is number => id !== null));
  }
}
