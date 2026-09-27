import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Link from 'next/link';

export default async function CheckoutCancelPage({
  searchParams,
}: {
  searchParams: Promise<{ class_id?: string }>;
}) {
  const params = await searchParams;
  const classId = params.class_id;
  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          Checkout canceled
        </Typography>
        <Typography>
          No registration was created. You can return to the class and try again
          whenever you are ready.
        </Typography>
        <Button
          component={Link}
          href={
            classId ? `/classes/${encodeURIComponent(classId)}` : '/classes'
          }
          variant="contained"
        >
          Return to classes
        </Button>
      </Stack>
    </Container>
  );
}
