'use client';

import Avatar from '@mui/material/Avatar';
import AvatarGroup from '@mui/material/AvatarGroup';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import CardMedia from '@mui/material/CardMedia';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import { format, parseISO } from 'date-fns';
import { useState } from 'react';
import { formatCost, fullName } from '@/lib/format';
import type { YogaClass } from '@/lib/types';

interface ClassCardProps {
  cls: YogaClass;
  onOpen: (cls: YogaClass) => void;
  isRegistered?: boolean;
}

export default function ClassCard({
  cls,
  onOpen,
  isRegistered = false,
}: ClassCardProps) {
  const teachers = cls.teachers ?? [];
  const [now] = useState(() => new Date().getTime());
  const hasEnded = parseISO(cls.endDate).getTime() < now;

  return (
    <Card>
      <CardActionArea onClick={() => onOpen(cls)}>
        {cls.imageUrl && (
          <CardMedia
            component="img"
            image={cls.imageUrl}
            alt={cls.name}
            sx={{ height: 160 }}
          />
        )}
        <CardContent>
          <Stack spacing={0.5}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Typography variant="h6" component="h2" noWrap>
                {cls.name}
              </Typography>
              <Stack direction="row" spacing={0.5}>
                {hasEnded && (
                  <Chip label="Ended" color="default" size="small" />
                )}
                {isRegistered && (
                  <Chip label="Registered" color="success" size="small" />
                )}
                {cls.isPrivate ? (
                  <Chip label="Private" color="secondary" size="small" />
                ) : (
                  <Chip
                    label="Public"
                    color="primary"
                    variant="outlined"
                    size="small"
                  />
                )}
              </Stack>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {format(new Date(cls.startDate), 'EEE, MMM d')} •{' '}
              {format(new Date(cls.startDate), 'h:mm a')} • {cls.duration} min
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <PlaceOutlinedIcon fontSize="small" color="disabled" />
              <Typography variant="body2" color="text.secondary">
                {cls.location.name ?? cls.location.city}, {cls.location.state}
              </Typography>
            </Stack>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                {teachers.length > 0 ? (
                  <AvatarGroup
                    max={3}
                    sx={{ '& .MuiAvatar-root': { width: 28, height: 28 } }}
                  >
                    {teachers.map((t) => (
                      <Avatar
                        key={t.id}
                        src={t.avatarUrl ?? undefined}
                        alt={fullName(t)}
                      />
                    ))}
                  </AvatarGroup>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No teacher assigned
                  </Typography>
                )}
                {teachers.length > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    {teachers.map(fullName).join(', ')}
                  </Typography>
                )}
              </Stack>
              <Stack
                direction="row"
                spacing={0.5}
                sx={{ alignItems: 'center' }}
              >
                <GroupOutlinedIcon fontSize="small" color="disabled" />
                <Typography variant="body2" color="text.secondary">
                  {cls.registrationCount ?? 0}/{cls.capacity}
                </Typography>
              </Stack>
            </Stack>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {formatCost(cls.cost)}
            </Typography>
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
