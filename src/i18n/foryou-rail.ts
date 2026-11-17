import { defineMessages } from './index'
export default defineMessages({
 en: { carousel: 'Carousel', previous: 'Previous view', next: 'Next view', position: (n:number,total:number)=>`View ${n} of ${total}` },
 fr: { carousel: 'Carrousel', previous: 'Vue précédente', next: 'Vue suivante', position: (n:number,total:number)=>`Vue ${n} sur ${total}` },
})
