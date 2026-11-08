/** The fence stores free text: recognize only unambiguous ISO day/month ends. */
export function takeHorizonSql(column: string): string {
  if (!/^(?:[a-z_]+\.)?until_date$/.test(column)) throw new Error("invalid take horizon column");
  const raw = `btrim(${column})`;
  const first = `make_date(substring(${raw}, 1, 4)::int, substring(${raw}, 6, 2)::int, 1)`;
  const day = `(${first} + (substring(${raw}, 9, 2)::int - 1))`;
  return `CASE
    WHEN ${raw} ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$'
      THEN (${first} + interval '1 month' - interval '1 day')::date
    WHEN ${raw} ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      THEN CASE WHEN to_char(${day}, 'YYYY-MM-DD') = ${raw} THEN ${day} END
    ELSE NULL END`;
}
