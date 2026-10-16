import { Company } from '../../prisma/generated/prisma/client';
import { format } from 'date-fns';

/** The date-fns patterns a company may choose as `Company.dateFormat`; anything else falls back. */
export const ALLOWED_DATE_FORMATS = [
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'yyyy/MM/dd',
  'dd.MM.yyyy',
  'dd-MM-yyyy',
  'yyyy-MM-dd',
  'EEEE, dd MMM yyyy',
];

export const formatDate = (company: Company, date?: Date | null) => {
  if (!date) return 'N/A';

  let dateFormat = company.dateFormat;
  const allowedFormats = ALLOWED_DATE_FORMATS;
  if (!allowedFormats.includes(dateFormat)) {
    dateFormat = 'dd/MM/yyyy'; // Default format if the stored format is invalid
  }
  return format(date, dateFormat);
};
